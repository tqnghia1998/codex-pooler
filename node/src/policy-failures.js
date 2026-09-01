export const MISALIGNMENT_POLICY_CODE = 'misalignment_policy_violation';

const FALLBACK_MESSAGE = 'This request was blocked due to a misalignment policy violation.';
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_DETAIL_BYTES = 64 * 1024;

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

// The native Codex app-server surface may use these bounded continuation hints
// to recover a turn. Public compatibility routes must continue using the stable
// OpenAI-shaped projection above.
export function nativeMisalignmentError(value) {
  const error = structuredError(value);
  if (error?.code !== MISALIGNMENT_POLICY_CODE) return null;
  const misalignment = normalizeMisalignmentDetails(error.misalignment);
  return {
    code: MISALIGNMENT_POLICY_CODE,
    message: safeMessage(error.message),
    ...(misalignment ? { misalignment } : {})
  };
}

export function normalizeMisalignmentDetails(value) {
  if (!plainObject(value)) return null;
  const errorType = optionalDetail(value.error_type);
  const detailedExplanation = optionalDetail(value.detailed_explanation);
  const steer = optionalSteer(value.steer);
  if (errorType === undefined || detailedExplanation === undefined || steer === undefined) return null;
  const result = {
    ...(errorType ? { error_type: errorType } : {}),
    ...(detailedExplanation ? { detailed_explanation: detailedExplanation } : {}),
    ...(steer ? { steer } : {})
  };
  return Object.keys(result).length ? result : null;
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

function optionalDetail(value) {
  if (value === undefined) return null;
  return typeof value === 'string' && Buffer.byteLength(value) <= MAX_DETAIL_BYTES ? value : undefined;
}

function optionalSteer(value) {
  if (value === undefined) return null;
  if (!plainObject(value) || typeof value.message !== 'string' || Buffer.byteLength(value.message) > MAX_DETAIL_BYTES) return undefined;
  return { message: value.message };
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeMessage(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_MESSAGE_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return FALLBACK_MESSAGE;
  }
  return value;
}
