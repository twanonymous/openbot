import type { MemoryCapturePreference } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

/**
 * Whether OpenBot saves durable facts from a conversation before a provider session hands it off. The
 * backend reads it at each handoff, so it is held in memory after `load`.
 *
 * A file that is missing, unreadable as JSON or not this shape reads as on, the default. Writes are
 * chained for the reason `update-preference-store.ts` chains its own.
 */
export class MemoryCapturePreferenceStore {
  readonly #path: string;
  #preference: MemoryCapturePreference = { enabled: true };
  #writes = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(
        readPreferenceFile(this.#path, (parsed): MemoryCapturePreference | null =>
          isDynamicRecord(parsed) && parsed.version === 1 && typeof parsed.enabled === "boolean"
            ? { enabled: parsed.enabled }
            : null,
        ),
      );
      if (Result.isSuccess(loaded)) {
        if (loaded.success) this.#preference = loaded.success;
      } else if (!isMissingFileError(loaded.failure.cause) && !(loaded.failure.cause instanceof SyntaxError))
        return yield* loaded.failure;
    });
  }

  get(): MemoryCapturePreference {
    return { ...this.#preference };
  }

  readonly set = Effect.fn("MemoryCapturePreference.set")(function* (
    this: MemoryCapturePreferenceStore,
    { enabled }: MemoryCapturePreference,
  ) {
    yield* this.#writes.withPermit(
      Effect.uninterruptible(
        writePreferenceFile(this.#path, { version: 1, enabled }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#preference = { enabled };
            }),
          ),
        ),
      ),
    );
    return this.get();
  });
}
