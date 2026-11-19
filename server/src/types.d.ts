// Types for the server's type check (PRO-209). Not loaded at runtime.

declare global {
  namespace Express {
    interface Request {
      /** The logged-in person (see accounts.verify), when the request carries a valid session. */
      account?: any;
      /** E-mail of the logged-in person. */
      user?: string;
      /** Id of the request, also in the X-Request-Id header (see log.js). */
      id?: string;
      /** Usage metrics count this console call (not the team's own tests). */
      countMetrics?: boolean;
    }
  }
}

export {};
