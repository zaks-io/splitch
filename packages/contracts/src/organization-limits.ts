/**
 * A User cannot own more Organizations than an authenticated session can
 * materialize. Keeping one shared bound prevents create from manufacturing an
 * account state the Control Panel cannot load completely.
 */
export const USER_OWNED_ORGANIZATION_LIMIT = 50;
