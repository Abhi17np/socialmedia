/**
 * SPF/DKIM/DMARC verification — split into pure record-matching
 * predicates (unit-tested, test/emailDomainCheck.test.js, no network) and
 * a thin DNS-resolving wrapper (checkDomainDns), so the actual decision
 * logic is verifiable without a live network call.
 *
 * Honesty note (see docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 3
 * entry): this session's sandboxed container has no outbound DNS egress
 * (only HTTPS through a configured proxy — a plain `dns.resolveTxt()`
 * call fails with ENOTFOUND even for a real domain like google.com,
 * confirmed by direct test). The predicate logic below is verified by
 * unit test; `checkDomainDns()` itself is implemented against Node's
 * documented `dns.promises` API and could not be exercised against a
 * real domain in this environment — verify it in a normal deployment
 * (or any environment with real DNS access) before relying on it.
 */
const dns = require('dns').promises;

function isValidSpfRecord(txtRecords) {
  return (txtRecords || []).some((r) => r.toLowerCase().startsWith('v=spf1'));
}

function isValidDkimRecord(txtRecords) {
  return (txtRecords || []).some((r) => r.toLowerCase().includes('v=dkim1'));
}

function isValidDmarcRecord(txtRecords) {
  return (txtRecords || []).some((r) => r.toLowerCase().startsWith('v=dmarc1'));
}

async function resolveTxtJoined(hostname) {
  try {
    return (await dns.resolveTxt(hostname)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function checkDomainDns(domain, dkimSelector) {
  const [spfRecords, dkimRecords, dmarcRecords] = await Promise.all([
    resolveTxtJoined(domain),
    dkimSelector ? resolveTxtJoined(`${dkimSelector}._domainkey.${domain}`) : Promise.resolve([]),
    resolveTxtJoined(`_dmarc.${domain}`)
  ]);
  return {
    spf: isValidSpfRecord(spfRecords),
    dkim: dkimSelector ? isValidDkimRecord(dkimRecords) : false,
    dmarc: isValidDmarcRecord(dmarcRecords)
  };
}

module.exports = { isValidSpfRecord, isValidDkimRecord, isValidDmarcRecord, checkDomainDns };
