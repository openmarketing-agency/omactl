import { OmaError } from '../core/errors';
export type TemplateContext = {
  appId: string;
  base_domain: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  links?: Record<string, Record<string, string>>;
  routes?: Record<string, { host: string; url: string }>;
};
export function render(text: string, ctx: TemplateContext, defer = false): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9_.:-]*)\}/g, (match, variable: string) => {
    if (variable === 'appId') return ctx.appId;
    if (variable === 'base_domain') return ctx.base_domain;
    const colon = variable.indexOf(':');
    const kind = variable.slice(0, colon);
    const key = variable.slice(colon + 1);
    const value =
      kind === 'env'
        ? ctx.env?.[key]
        : kind === 'output'
          ? ctx.outputs?.[key]
          : kind === 'host'
            ? ctx.routes?.[key]?.host
            : kind === 'url'
              ? ctx.routes?.[key]?.url
              : kind === 'link'
                ? (() => {
                    const i = key.lastIndexOf('.');
                    return ctx.links?.[key.slice(0, i)]?.[key.slice(i + 1)];
                  })()
                : undefined;
    if (value !== undefined) return value;
    if (defer && ['output', 'link'].includes(kind)) return match;
    throw new OmaError('UNKNOWN_TEMPLATE', `Unresolved template variable ${match}`, 3);
  });
}
export function templateVariables(text: string) {
  return [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_.:-]*)\}/g)].map((m) => m[1]);
}
