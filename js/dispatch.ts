// Copyright 2018 the Deno authors. All rights reserved. MIT license.
import { libdeno } from "./libdeno";
import { flatbuffers } from "flatbuffers";
import * as msg from "gen/msg_generated";
import * as errors from "./errors";
import * as util from "./util";
import { maybePushTrace } from "./trace";
import { promiseErrorExaminer } from "./promise_util";

let nextCmdId = 0;
const promiseTable = new Map<number, util.Resolvable<msg.Base>>();

let fireTimers: () => number;
let nTasks = 0; // Number of async tasks pending.
let delay = 0; // Cached return value of fireTimers.

function eventLoopLog(): void {
  util.log(`TICK delay ${delay} nTasks ${nTasks}`);
}

function idle(): boolean {
  delay = fireTimers();
  return delay < 0 && nTasks === 0;
}

export function eventLoop(): boolean {
  for (;;) {
    if (idle()) {
      libdeno.runMicrotasks();
      if (idle()) {
        break;
      }
    }
    eventLoopLog();
    const ui8 = poll(delay);
    if (ui8 != null) {
      handleAsyncMsgFromRust(ui8);
      libdeno.runMicrotasks();
    }

    if (!promiseErrorExaminer()) {
      return false;
    }
  }

  return promiseErrorExaminer();
}

// delay is in milliseconds.
// delay < 0 hangs forever.
// WARNING: poll is a special op. Messages returned from poll will
// not have the same cmd_id.
// WARNING: poll does not go thru sendSync or sendAsync. It is not a real op.
export function poll(delay: number): null | Uint8Array {
  const builder = new flatbuffers.Builder();
  msg.Poll.startPoll(builder);
  msg.Poll.addDelay(builder, delay);
  const inner = msg.Poll.endPoll(builder);
  const innerType = msg.Any.Poll;
  const [pollCmdId, resBuf] = sendInternal(
    builder,
    innerType,
    inner,
    undefined,
    true
  );
  util.assert(pollCmdId > 0);
  return resBuf;
}

export function setFireTimersCallback(fn: () => number) {
  fireTimers = fn;
}

export function handleAsyncMsgFromRust(ui8: Uint8Array) {
  const bb = new flatbuffers.ByteBuffer(ui8);
  const base = msg.Base.getRootAsBase(bb);
  const cmdId = base.cmdId();
  util.log(
    `handleAsyncMsgFromRust cmdId ${cmdId} ${msg.Any[base.innerType()]}`
  );
  const promise = promiseTable.get(cmdId);
  util.assert(promise != null, `Expecting promise in table. ${cmdId}`);
  promiseTable.delete(cmdId);
  const err = errors.maybeError(base);
  if (err != null) {
    promise!.reject(err);
  } else {
    promise!.resolve(base);
  }
  util.assert(nTasks > 0);
  nTasks--;
}

// @internal
export function sendAsync(
  builder: flatbuffers.Builder,
  innerType: msg.Any,
  inner: flatbuffers.Offset,
  data?: ArrayBufferView
): Promise<msg.Base> {
  maybePushTrace(innerType, false); // add to trace if tracing
  util.assert(nTasks >= 0);
  nTasks++;
  const [cmdId, resBuf] = sendInternal(builder, innerType, inner, data, false);
  util.assert(resBuf == null);
  const promise = util.createResolvable<msg.Base>();
  promiseTable.set(cmdId, promise);
  return promise;
}

// @internal
export function sendSync(
  builder: flatbuffers.Builder,
  innerType: msg.Any,
  inner: flatbuffers.Offset,
  data?: ArrayBufferView
): null | msg.Base {
  maybePushTrace(innerType, true); // add to trace if tracing
  const [cmdId, resBuf] = sendInternal(builder, innerType, inner, data, true);
  util.assert(cmdId >= 0);
  // WARNING: in the case of poll() cmdId may not be the same in the outgoing
  // message.
  if (resBuf == null) {
    return null;
  } else {
    const u8 = new Uint8Array(resBuf!);
    const bb = new flatbuffers.ByteBuffer(u8);
    const baseRes = msg.Base.getRootAsBase(bb);
    errors.maybeThrowError(baseRes);
    return baseRes;
  }
}

function sendInternal(
  builder: flatbuffers.Builder,
  innerType: msg.Any,
  inner: flatbuffers.Offset,
  data: undefined | ArrayBufferView,
  sync = true
): [number, null | Uint8Array] {
  const cmdId = nextCmdId++;
  msg.Base.startBase(builder);
  msg.Base.addInner(builder, inner);
  msg.Base.addInnerType(builder, innerType);
  msg.Base.addSync(builder, sync);
  msg.Base.addCmdId(builder, cmdId);
  builder.finish(msg.Base.endBase(builder));
  return [cmdId, libdeno.send(builder.asUint8Array(), data)];
}
