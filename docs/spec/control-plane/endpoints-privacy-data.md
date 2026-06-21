# Control-plane endpoints: privacy data requests

Request/response shapes for privacy request intake, export jobs, deletion jobs, and Entity data
subject requests. The lifecycle rules live in
[../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md).

All endpoints live on the **Control Plane API Worker** unless noted. They require a control-plane bearer
token and write an audit event plus a `privacy_requests` D1 row.

## Shared shapes

```
PrivacyRequest {
  request_id: string
  org_id: string
  app_id?: string
  request_type: 'access' | 'export' | 'correct' | 'delete' | 'opt_out_sale_share' | 'limit_sensitive'
  subject_type: 'user' | 'organization' | 'app' | 'entity'
  subject_ref: string | string[]
  status: 'received' | 'verifying' | 'processing' | 'completed' | 'denied'
  received_at: string
  ack_due_at: string
  response_due_at: string
  completed_at?: string
  denial_reason?: string
}

PrivacyJob {
  job_id: string
  request_id: string
  kind: 'export' | 'delete'
  status: 'queued' | 'running' | 'completed' | 'failed'
  store_status: Record<string, 'pending' | 'done' | 'failed' | 'skipped'>
  download_url?: string
  expires_at?: string
}
```

`subject_ref` for Entity requests is the server-computed `targeting_key_hash` set, never the raw
Targeting Key.

## User privacy endpoints

### `POST /users/me/privacy/export`

Creates an export for the authenticated control-plane User.

Returns: `{ request: PrivacyRequest, job: PrivacyJob }`

Includes WorkOS profile data, memberships, token metadata, and audit entries where this User is the
actor. Raw API Key values and other Users' data are excluded.

### `DELETE /users/me`

Requests deletion of the authenticated User.

Rules:

- Revokes sessions, device-flow refresh tokens, MCP tokens, and CLI tokens immediately.
- Removes Org/App memberships.
- If this User is the last owner of a personal Organization, deletion cascades to personal
  Organization deletion.
- If this User is the last owner of a shared Organization, returns `LAST_OWNER_REQUIRED`.

Returns: `{ request: PrivacyRequest, job: PrivacyJob }`

## Organization and App exports

### `POST /orgs/{org_id}/privacy/export`

Auth: Org `owner`.

Returns an Organization export job. Includes Apps, Environments, config, credential metadata, members,
audit rows, and billing metadata. Excludes raw API Key values and processor-internal secrets.

### `POST /apps/{app_id}/privacy/export`

Auth: App `owner` or `admin`.

Returns an App export job. Includes Flag, Experiment, Run, Metric, Segment, credential metadata, result
inputs, and audit rows for that App.

## Organization and App deletion

### `DELETE /orgs/{org_id}`

Auth: Org `owner`.

Rules:

- Requires explicit confirmation token from a prior dry-run response.
- Revokes all SDK credentials immediately.
- Ends running Experiment Runs with reason `org_delete`.
- Commits deletion tombstones before async physical purge.
- Enterprise Orgs may require billing/SSO checks before the job starts.

Returns: `{ request: PrivacyRequest, job: PrivacyJob }`

### `DELETE /apps/{app_id}`

Auth: App `owner`.

Normal App deletion remains blocked by running Experiments unless this is an account-closure privacy
delete. In privacy-delete mode, the job ends running Runs with reason `app_delete`, revokes credentials,
commits tombstones, then purges stores.

Returns: `{ request: PrivacyRequest, job: PrivacyJob }`

## Entity requests

Entity requests are customer data subject operations. Auth: App `owner` or `admin`.

### `POST /apps/{app_id}/privacy/entities/export`

Body:

```
{
  id_type: string,
  targetingKey: string
}
```

The Worker computes `targeting_key_hash` for every active salt version and exports matching Assignment
Store records, raw events, deduped snapshots, Metric rows, and source/category/purpose metadata.

Returns: `{ request: PrivacyRequest, job: PrivacyJob }`

### `POST /apps/{app_id}/privacy/entities/delete`

Body:

```
{
  id_type: string,
  targetingKey: string
}
```

The Worker computes `targeting_key_hash` for every active salt version, inserts `entity_deletions`
tombstones, and queues physical purge across KV, Assignment Store DO, Tinybird raw rows, snapshots,
and rollups.

The Analysis Worker MUST exclude rows where `server_ts <= delete_before_ts` immediately after the
tombstone commits. New events after `delete_before_ts` are newly collected data.

Returns: `{ request: PrivacyRequest, job: PrivacyJob }`

## Request status

### `GET /privacy/requests/{request_id}`

Auth: requester, Org `owner`, or App `owner/admin` when the request is App-scoped.

Returns: `{ request: PrivacyRequest, job?: PrivacyJob }`

## Error codes

- `LAST_OWNER_REQUIRED` when User deletion would leave a shared Org with no owner.
- `PRIVACY_CONFIRMATION_REQUIRED` when Org/App deletion lacks a confirmation token.
- `PRIVACY_JOB_NOT_FOUND` when a request/job ID is unknown to the caller.
- `PRIVACY_JOB_FAILED` when one or more store purge steps failed and require operator follow-up.

## Sources

- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
- [access-control-matrix.md](access-control-matrix.md)
- [d1-and-tinybird-data-access.md](d1-and-tinybird-data-access.md)
