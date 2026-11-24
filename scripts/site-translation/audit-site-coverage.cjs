#!/usr/bin/env node
'use strict';

// 从实际规则和证据索引生成维护视图。主机声明只用于安排复验，不模拟运行时 URL/DOM 匹配。
const fs = require('node:fs');
const path = require('node:path');

const CATALOG_ROOT = path.join(__dirname, '../../src/core/site-adaptation/catalog');
const read = (name) => JSON.parse(fs.readFileSync(path.join(CATALOG_ROOT, `${name}.json`), 'utf8'));
const readBrowserCases = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../../tests/browser-translation-cases.json'), 'utf8'));

function hostDeclared(pattern, host) {
  return pattern === host || pattern.startsWith('*.') &&
    (host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`));
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function auditSiteCoverage({established = read('established'), websites = read('websites'),
  profiles = read('profiles'), coverage = read('coverage'), browserCases = readBrowserCases()} = {}) {
  const rules = [...established, ...websites];
  const metadata = new Map(coverage.rules.map((entry) => [entry.id, entry]));
  const ids = new Set(rules.map((rule) => rule.id));
  const errors = [];
  if (ids.size !== rules.length) errors.push('Duplicate built-in rule IDs');
  if (metadata.size !== coverage.rules.length) errors.push('Duplicate evidence metadata IDs');
  for (const id of metadata.keys()) if (!ids.has(id)) errors.push(`Evidence metadata has no rule: ${id}`);
  for (const rule of websites) if (!metadata.has(rule.id)) errors.push(`Website rule has no evidence metadata: ${rule.id}`);
  const withoutEvidenceMetadata = rules.filter((rule) => !metadata.has(rule.id)).map((rule) => rule.id).sort();
  const priorityIds = new Set();
  const prioritySites = (coverage.prioritySites || []).flatMap((site) => {
    const label = site?.id || '(missing id)';
    const validHost = typeof site?.host === 'string' && site.host.split('.').length >= 2 &&
      site.host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part));
    if (!site || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(site.id || '') ||
      typeof site.name !== 'string' || !site.name.trim() || !validHost ||
      !Array.isArray(site.reviewSurfaces) || !site.reviewSurfaces.length ||
      site.reviewSurfaces.some((surface) => typeof surface !== 'string' || !surface.trim()) ||
      site.browserCases !== undefined && (!Array.isArray(site.browserCases) ||
        site.browserCases.some((name) => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)))) {
      errors.push(`Invalid priority site: ${label}`);
      return [];
    }
    if (priorityIds.has(site.id)) {
      errors.push(`Duplicate priority site ID: ${site.id}`);
      return [];
    }
    priorityIds.add(site.id);
    const browserContracts = Object.entries(browserCases).flatMap(([id, contract]) => {
      let url;
      try {url = new URL(contract.url);} catch {return [];}
      if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== site.host) return [];
      return [{id, url: contract.url, tier: contract.tier || 'required', modes: contract.modes || [],
        fullPageScope: contract.fullPageScope || 'finite-page'}];
    });
    for (const id of site.browserCases || []) {
      if (!Object.hasOwn(browserCases, id)) errors.push(`Priority site ${site.id} references missing browser case: ${id}`);
      else if (!browserContracts.some((contract) => contract.id === id)) errors.push(`Priority site ${site.id} browser case has a different host: ${id}`);
    }
    const declarations = rules.filter((rule) => rule.match.hosts.some((host) => hostDeclared(host, site.host)));
    return [{...site, status: declarations.length ? 'declared-host-needs-page-verification' : 'no-dedicated-rule',
      browserContracts,
      declarations: declarations.map((rule) => ({id: rule.id,
        paths: rule.match.paths || ['*'], excludePaths: rule.match.excludePaths || [],
        mode: rule.mode || profiles[rule.profile]?.mode || 'augment', profile: rule.profile || null,
        verification: metadata.get(rule.id)?.verification || 'not-recorded-in-coverage',
        historicalLiveEvidence: metadata.get(rule.id)?.liveVerification || 'not-recorded-in-coverage'}))}];
  });
  return {schemaVersion: 1, ok: errors.length === 0,
    boundary: 'Counts describe declarations and recorded evidence, not successful current live-site translations. Host matches do not prove path or DOM coverage. Historical evidence is not a current pass.',
    catalog: {establishedRules: established.length, websiteRules: websites.length, totalRules: rules.length,
      uniqueHostPatterns: new Set(rules.flatMap((rule) => rule.match.hosts)).size,
      websiteHostPatterns: new Set(websites.flatMap((rule) => rule.match.hosts)).size,
      profiles: Object.keys(profiles).length,
      categories: countBy(rules.map((rule) => metadata.get(rule.id)?.category || 'established-unclassified')),
      verification: countBy(rules.map((rule) => metadata.get(rule.id)?.verification || 'not-recorded-in-coverage'))},
    withoutEvidenceMetadata, prioritySites, errors};
}

function renderText(report) {
  const {catalog} = report;
  const lines = [`Built-in declarations: ${catalog.totalRules} (${catalog.establishedRules} established + ${catalog.websiteRules} website rules)`,
    `Host patterns: ${catalog.uniqueHostPatterns}; profiles: ${catalog.profiles}`,
    `Categories: ${JSON.stringify(catalog.categories)}`, `Recorded verification: ${JSON.stringify(catalog.verification)}`,
    report.boundary, '', 'Priority website review:'];
  for (const site of report.prioritySites) {
    lines.push(`- ${site.name} (${site.host}): ${site.status}; rules=${site.declarations.map((rule) => rule.id).join(',') || 'none'}`);
    lines.push(`  Review separately: ${site.reviewSurfaces.join('; ')}`);
    if (site.browserContracts.length) lines.push(`  Registered browser contracts (not pass results): ${site.browserContracts.map((contract) => `${contract.id} [${contract.tier}; ${contract.fullPageScope}]`).join(', ')}`);
    for (const rule of site.declarations) lines.push(`  ${rule.id}: paths=${rule.paths.join(',')}; evidence=${rule.verification}; historical live evidence=${rule.historicalLiveEvidence}`);
  }
  if (report.withoutEvidenceMetadata.length) lines.push('', `No per-rule coverage metadata: ${report.withoutEvidenceMetadata.join(', ')}`);
  if (report.errors.length) lines.push('', ...report.errors.map((error) => `ERROR: ${error}`));
  return lines.join('\n');
}

if (require.main === module) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--json')) {
    process.stderr.write('Usage: node scripts/site-translation/audit-site-coverage.cjs [--json]\n');
    process.exitCode = 1;
  } else {
    const report = auditSiteCoverage();
    process.stdout.write(`${flags.includes('--json') ? JSON.stringify(report, null, 2) : renderText(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
}

module.exports = {auditSiteCoverage, renderText};
