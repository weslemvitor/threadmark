export type AuthErrorCode =
  | "invalid_input"
  | "setup_required"
  | "setup_already_completed"
  | "invalid_credentials"
  | "account_locked"
  | "authentication_required"
  | "session_expired"
  | "forbidden"
  | "user_not_found"
  | "username_taken"
  | "last_owner_protected";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
