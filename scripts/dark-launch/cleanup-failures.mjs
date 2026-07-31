export async function captureCleanupFailure(failures, label, action, onSuccess) {
  try {
    const result = await action();
    onSuccess?.(result);
    return result;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    failures.push(new Error(`${label} failed: ${detail}`, { cause }));
    return undefined;
  }
}

export function throwPrimaryWithCleanup(primaryFailure, cleanupFailures, message) {
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], message, {
      cause: primaryFailure,
    });
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, message);
}
