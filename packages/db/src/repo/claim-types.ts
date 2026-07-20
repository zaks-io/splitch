export interface ClaimHashes {
  provisionalUserHash: string;
  emailHash: string;
}

export interface ClaimIdentityHashes extends ClaimHashes {
  organizationHash: string;
  appHash: string;
  verifiedUserHash: string;
}

export interface ClaimVerification extends ClaimHashes {
  id: string;
  selectedResource: string | null;
  expiresAt: string;
  attempts: number;
  verifiedAt: string | null;
  consumedAt: string | null;
}
