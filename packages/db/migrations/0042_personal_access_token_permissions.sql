-- Preserve existing PAT authority before Workers switch to permission grants.
-- Rows without legacy access fields are not rewritten, including on re-apply.
UPDATE personal_access_tokens
SET grants = (
  SELECT json_group_array(json(
    CASE WHEN json_type(grant.value, '$.access') IS NOT NULL THEN
      json_set(
        json_remove(grant.value, '$.access'),
        '$.permissions',
        json(CASE json_extract(grant.value, '$.access')
          WHEN 'read' THEN '[]'
          WHEN 'read-write' THEN '["write","delete","credentials","members","privacy"]'
          ELSE 'invalid legacy PAT access'
        END)
      )
    ELSE grant.value END
  ))
  FROM json_each(personal_access_tokens.grants) AS grant
)
WHERE EXISTS (
  SELECT 1 FROM json_each(personal_access_tokens.grants) AS grant
  WHERE json_type(grant.value, '$.access') IS NOT NULL
);
