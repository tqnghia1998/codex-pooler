export const MISALIGNMENT_POLICY_CODE = 'misalignment_policy_violation';

const FALLBACK_MESSAGE = 'This request was blocked due to a misalignment policy violation.';
const MAX_MESSAGE_BYTES = 4 * 1024;

export function misalignmentPolicyFailure(value) {
  const error = structuredError(value);
  if (error?.code !== MISALIGNMENT_POLICY_CODE) return null;
  return {
    code: MISALIGNMENT_POLICY_CODE,
    message: safeMessage(error.message)
  };
}

export function publicMisalignmentError(value) {
  const failure = misalignmentPolicyFailure(value);
  return failure
    ? { type: 'invalid_request_error', code: failure.code, message: failure.message }
    : null;
}

function structuredError(value) {
  return [
    value?.error,
    value?.response?.error,
    value?.status_details?.error,
    value?.response?.status_details?.error,
    value
  ].find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)) || null;
}

function safeMessage(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_MESSAGE_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return FALLBACK_MESSAGE;
  }
  return value;
}
