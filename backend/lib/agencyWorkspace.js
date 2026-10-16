/**
 * Pure authorization logic for Agency Workspace (migration 043,
 * routes/agency.js). No DB, no network — which side of an agency_links
 * row may approve/revoke it, and which "direction" it reads as for a
 * given tenant, are real access-control decisions this app's rule about
 * backend-enforced entitlements/isolation applies to just as much as any
 * money-metered one, so they're isolated and unit tested the same way
 * lib/crisisDetection.js's/lib/decisionSimulator.js's math is.
 */

/** Only the AGENCY side may approve a link, and only while it's still pending — the client's own proposal already is its half of consent; approval is the agency's. */
function canApprove(link, actingTenantId) {
  return link.status === 'pending' && link.agency_tenant_id === actingTenantId;
}

/** Either side may revoke, at any time before it's already revoked — the client can stop sharing, the agency can drop a client, independently. */
function canRevoke(link, actingTenantId) {
  return link.status !== 'revoked' && (link.agency_tenant_id === actingTenantId || link.client_tenant_id === actingTenantId);
}

/** How this link reads from the given tenant's own point of view — never assume the caller already knows which side it's on. */
function linkDirection(link, viewingTenantId) {
  if (link.agency_tenant_id === viewingTenantId) return 'as_agency';
  if (link.client_tenant_id === viewingTenantId) return 'as_client';
  return null; // this tenant is party to neither side — callers must never reach this; see routes/agency.js's own tenant-scoping
}

module.exports = { canApprove, canRevoke, linkDirection };
