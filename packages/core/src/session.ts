/** A browser session; the token itself is handed out once and never stored. */
export interface Session {
  /** SHA-256 of the token, hex. */
  idHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  /** The absolute end of the session, however active it is. */
  expiresAt: string;
}
