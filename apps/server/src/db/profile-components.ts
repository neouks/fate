// Presentation-only observations extracted from saved statements. Keep the source
// even when a component cannot yet be assigned to a particular asset.
export interface ComponentSource {
  kind: "activity" | "fact";
  id: string;
  role: string;
  session: string | null;
  seen: string;
}
export interface ProfileAsset {
  id: string;
  domain: string | null;
  ip: string | null;
  port: number | null;
  url: string | null;
  type: string;
}
interface Mention {
  category: string;
  name: string;
  version: string;
  references: string[];
}
export interface Component extends Omit<Mention, "references"> {
  asset_id: string | null;
  historical: boolean;
  sources: ComponentSource[];
}

const categories: Record<string, string> = {
  中间件: "中间件",
  middleware: "中间件",
  应用服务器: "中间件",
  数据库: "数据库",
  database: "数据库",
  dbms: "数据库",
  框架: "框架",
  framework: "框架",
  操作系统: "操作系统",
  运行时: "运行时",
  组件: "组件",
  技术栈: "组件",
  web服务器: "Web 服务器",
  "web 服务器": "Web 服务器",
};
const category = Object.keys(categories).join("|");
const categoryMarker = new RegExp(category, "i");
const product =
  /([A-Za-z][A-Za-z0-9_+.-]{0,127}(?![A-Za-z0-9_+.-])(?:[ ]+(?:Server|Database|Linux|HTTP Server|Framework))?|[\p{Script=Han}]{2,16}(?=[\s，。；,;]|$))/u
    .source;
const version = /(?:[ \t]+(?:版本(?:号)?\s*[:：为]?\s*)?([vV]?\d[\w.-]{0,63}))?/.source;
const declaration = new RegExp(
  "(" +
    category +
    ")(?:产品|类型|引擎)?(?:[ \\t]*(?:确认为|更正为|更新为|实际为|使用的是|使用|采用|运行|是|为|[:：=]|\\bis\\b)\\s*|[ \\t]+)" +
    product +
    version,
  "giu",
);
const namedCategory = new RegExp("(?<![A-Za-z0-9_.+-])" + product + version + "[ \\t]*(" + category + ")", "giu");
const affirmative =
  /确[认定]|实测|(?:后端|实际|使用的|识别结果)(?:为|是)|使用|采用|运行|检出|识别出|检测到|显示|发现|已验证|部署|\b(?:uses?|runs?|confirmed|detected)\b/i;
const uncertain =
  /[?？]|是否|未(?:发现|检测|检出|使用|确认|验证|知)|未知|不是|并非|没有|可能|疑似|推测|假设|例如|比如|计划|建议|需要确认|待(?:确认|核实|验证)|如果|若为|能否|待查|排查|检查是否|怀疑|据猜测|不使用|未能|并未|拟验证|打算|请验证|\b(?:if|maybe|not|possibly|unknown|check whether|example)\b/i;
const placeholder =
  /^(?:querying$|query$|the$|a$|an$|this$|uses?$|running$|error$|unknown|none|null|is$|version$|not$|未|未知|暂未|待确认|待核实|不确定|可能)/i;

function references(text: string) {
  const ids = [...text.matchAll(/(?:资产|asset)\s*(?:ID\s*)?[#＃:]?\s*(\d+)/gi)].map((m) => "#" + m[1]);
  const addresses =
    text.match(/https?:\/\/[^\s,，。；;、）)]+|(?:\[[\da-f:]+\]|(?<![\da-z.-])(?:[\da-z-]{1,63}\.)+[\da-z-]{1,63})(?::\d+)?/gi) ?? [];
  const hosts = addresses.filter(
    (value) =>
      /^(?:https?:|\[)/i.test(value) ||
      /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(value) ||
      /\.[a-z][a-z0-9-]*(?::\d+)?$/i.test(value),
  );
  return [...new Set([...ids, ...hosts])];
}

export function extractComponents(text: string): Mention[] {
  const mentions: Mention[] = [];
  const plain = text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/[*`]/g, "");
  for (const sentence of plain.split(/[。；;\n]|(?<=[a-z0-9])\.\s+(?=[A-Z])/i)) {
    if (!categoryMarker.test(sentence)) continue;
    let context: string[] = [];
    if (/[?？]/.test(sentence)) continue;
    let listing = false;
    for (const clause of sentence.split(/[，,、]/)) {
      // Product version strings (e.g. V10.0.5.3.9) aren't asset references.
      const refs = references(clause.replace(declaration, "").replace(namedCategory, ""));
      if (refs.length) context = refs;
      if (uncertain.test(clause)) {
        listing = false;
        continue;
      }
      const before = mentions.length;
      for (const m of clause.matchAll(declaration)) {
        const name = m[2]!.replace(/\.$/, "");
        if (placeholder.test(name)) continue;
        mentions.push({
          category: categories[m[1]!.toLowerCase()]!,
          name,
          version: (m[3] ?? "").replace(/\.$/, ""),
          references: [...context],
        });
      }
      if (
        affirmative.test(clause) ||
        listing ||
        /^\s*(?:[-•]\s*)?[A-Za-z][A-Za-z0-9_.+-]*(?:\s+[vV]?\d[\w.-]*)?\s*(?:数据库|中间件|框架)\s*$/.test(clause)
      ) {
        for (const m of clause.matchAll(namedCategory)) {
          if (placeholder.test(m[1]!)) continue;
          mentions.push({
            category: categories[m[3]!.toLowerCase()]!,
            name: m[1]!,
            version: m[2] ?? "",
            references: [...context],
          });
        }
      }
      listing = mentions.length > before;
    }
  }
  return mentions;
}

function resolveAsset(refs: string[], assets: ProfileAsset[], anchors: string[]) {
  const candidates = anchors.length ? assets.filter((a) => anchors.includes(a.id)) : assets;
  if (!refs.length) return anchors.length === 1 ? (candidates[0]?.id ?? null) : null;
  let common = candidates;
  for (const ref of refs) {
    const normalized = ref.toLowerCase().replace(/\/$/, "");
    common = common.filter((a) => {
      if (ref.startsWith("#")) return ref.slice(1) === a.id;
      if (ref.includes("://")) return a.url?.toLowerCase().replace(/\/$/, "") === normalized;
      return [a.ip, a.domain].some(
        (host) => host && [host, host + ":" + a.port].some((v) => v.toLowerCase() === normalized),
      );
    });
    if (!common.length) return null;
  }
  return common.length === 1 ? common[0]!.id : null;
}

export function groupComponents(
  records: { source: ComponentSource; mentions: Mention[]; anchors: string[] }[],
  assets: ProfileAsset[],
) {
  const entries = records.flatMap((r) =>
    r.mentions.map((m) => ({
      ...m,
      source: r.source,
      asset: resolveAsset(m.references, assets, r.anchors),
      unscoped: !m.references.length && !r.anchors.length,
    })),
  );
  const productKey = (e: { category: string; name: string }) => JSON.stringify([e.category, e.name.toLowerCase()]);
  const bound = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (!entry.asset) continue;
    const key = productKey(entry);
    const list = bound.get(key) ?? [];
    list.push(entry);
    bound.set(key, list);
  }
  for (const e of entries) {
    if (e.asset || !e.unscoped) continue;
    const compatible = (bound.get(productKey(e)) ?? []).filter(
      (b) => !b.version || !e.version || b.version.toLowerCase() === e.version.toLowerCase(),
    );
    const assets = new Set(compatible.map((b) => b.asset));
    if (assets.size === 1) e.asset = compatible[0]!.asset;
  }
  const versions = new Map<string, Set<string>>();
  const scopedProduct = (e: (typeof entries)[number]) => JSON.stringify([e.asset, productKey(e)]);
  for (const e of entries) {
    if (!e.version) continue;
    const values = versions.get(scopedProduct(e)) ?? new Set<string>();
    values.add(e.version);
    versions.set(scopedProduct(e), values);
  }
  const groups = new Map<string, Component>();
  for (const e of entries) {
    const asset = e.asset;
    const values = versions.get(scopedProduct(e));
    const version = e.version || (values?.size === 1 ? [...values][0]! : "");
    const key = JSON.stringify([scopedProduct(e), version.toLowerCase()]);
    const item = groups.get(key) ?? {
      category: e.category,
      name: e.name,
      version,
      asset_id: asset,
      historical: false,
      sources: [] as ComponentSource[],
    };
    if (!item.sources.some((s) => s.kind === e.source.kind && s.id === e.source.id)) item.sources.push(e.source);
    groups.set(key, item);
  }
  const components = [...groups.values()];
  const latestUserDB = new Map<string, string>();
  for (const item of components) {
    item.sources.sort((a, b) => b.seen.localeCompare(a.seen) || Number(b.id) - Number(a.id));
    const user = item.sources.find((s) => s.role === "用户");
    if (item.asset_id && item.category === "数据库" && user && user.seen > (latestUserDB.get(item.asset_id) ?? ""))
      latestUserDB.set(item.asset_id, user.seen);
  }
  for (const item of components) {
    const correction = item.asset_id && latestUserDB.get(item.asset_id);
    item.historical =
      !!correction &&
      item.category === "数据库" &&
      !item.sources.some((s) => s.role === "用户" && s.seen === correction) &&
      item.sources.some((s) => s.seen < correction);
  }
  return components.sort(
    (a, b) =>
      Number(a.historical) - Number(b.historical) ||
      b.sources[0]!.seen.localeCompare(a.sources[0]!.seen) ||
      a.name.localeCompare(b.name),
  );
}
