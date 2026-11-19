export function readable(envelope: any): string {
  const { command, data, error } = envelope;
  if (error) {
    let text = `${error.code}: ${error.message}\n`;
    if (error.hint) text += error.hint + '\n';
    if (error.details?.checks) text += checks(error.details.checks);
    if (data) text += readable({ command, data, error: null });
    return text;
  }
  if (data?.steps && data?.command)
    return `Plan: ${data.command}\n${data.steps.map((s: string) => `  - ${s}`).join('\n')}\n${data.confirmation ? `Requires --confirm ${data.confirmation}\n` : ''}`;
  if (command === 'version')
    return `omactl ${data.version}\nCatalog: ${data.catalog ?? 'not installed'}\nPlatform: ${data.platform} (tier ${data.support_tier})\n`;
  if (command === 'doctor') return `Support tier: ${data.support_tier}\n` + checks(data.checks);
  if (command === 'tunnel') return data.url + '\n';
  if (command === 'logs') return data.logs;
  if (command === 'exec') return data.stdout + data.stderr;
  if (command === 'status')
    return (
      data.apps
        .map(
          (app: any) =>
            `${app.id.padEnd(18)} ${app.version.padEnd(12)} ${app.state} (desired: ${app.desired_state})\n  Containers: ${app.containers.map((c: any) => `${c.Service}=${c.Health || c.State}`).join(', ') || 'none'}; override: ${app.override ? 'yes' : 'no'}\n  Verify: ${app.last_verify ? `${app.last_verify.ok ? 'passed' : 'failed'} ${app.last_verify.at}` : 'never'}; backup: ${app.last_backup?.at ?? 'never'}\n${app.tunnel ? `  Quick Tunnel: ${app.tunnel.url} (${app.tunnel.configured ? 'configured' : 'configuration incomplete'})\n` : ''}`,
        )
        .join('') +
      (data.orphaned_volumes.length
        ? `Orphaned volumes: ${data.orphaned_volumes.join(', ')}\n`
        : '')
    );
  if (command === 'history')
    return (
      data.operations
        .map(
          (o: any) =>
            `${o.id}  ${o.command}  ${o.result?.ok ? 'success' : (o.result?.code ?? 'running')}\n`,
        )
        .join('') || 'No operations.\n'
    );
  if (command === 'catalog list')
    return `Catalog ${data.version}\n${data.apps.map((a: any) => `${a.id.padEnd(18)} ${a.version.padEnd(12)} ${a.description}`).join('\n')}\nBundles: ${data.bundles.join(', ')}\n`;
  if (data?.results)
    return data.results
      .map(
        (r: any) =>
          `${r.app}: ${r.skipped ? 'unchanged' : r.ok ? 'ok' : 'failed'}${r.snapshot ? ' (snapshot ' + r.snapshot + ')' : ''}${r.error ? ' — ' + r.error : ''}\n`,
      )
      .join('');
  if (command === 'update')
    return `Catalog: ${data.current} -> ${data.available}\n${data.changed.length ? data.changed.map((c: any) => `  ${c.app}: ${c.from} -> ${c.to}`).join('\n') : 'No installed apps changed.'}\n`;
  return JSON.stringify(data, null, 2) + '\n';
}
function checks(items: any[]) {
  return items
    .map(
      (c) =>
        `[${c.status.toUpperCase()}] ${c.name}: ${c.message}${c.status !== 'ok' && c.hint ? ` (${c.hint})` : ''}\n`,
    )
    .join('');
}
