-- App-name resolution starts from the authenticated User's Organization
-- memberships, then uses apps_org_key_unique for the per-Organization key
-- lookup. The primary key is ordered (org_id, user_id), so it cannot serve the
-- user_id-first predicate without this index.
CREATE INDEX `org_memberships_user_id_idx` ON `org_memberships` (`user_id`);
