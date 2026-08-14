export { AuthError, type AuthErrorCode } from "./errors.js";
export { hashPassword, verifyPassword } from "./password.js";
export {
  SetupChallengeService,
  type IssuedSetupChallenge,
} from "./setup-challenge.js";
export {
  LocalAuthService,
  type AuthenticatedSession,
  type IssuedAuthSession,
  type LocalAuthServiceOptions,
} from "./service.js";
