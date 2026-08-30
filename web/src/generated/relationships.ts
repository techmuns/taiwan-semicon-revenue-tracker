// GENERATED FILE - do not edit. Source: config/relationships.yaml
//
// Companies whose revenue is already inside another tracked company's reported
// figure. They are removed from SUMS ONLY - the universe total and the per-stage
// aggregates. Their own rows, series and acceleration are untouched, because a
// subsidiary's own numbers are perfectly real; it is only adding them to the
// parent that double counts.
//
// Regenerate with:  python -m twrev.cli validate --write

export interface ConsolidationPair {
  parent: string;
  child: string;
  parentName: string;
  childName: string;
}

export const CONSOLIDATION: readonly ConsolidationPair[] = [
  { parent: "3231", child: "6669", parentName: "Wistron", childName: "Wiwynn" },
];

/** Tickers to drop from any SUM across companies. */
export const EXCLUDED_FROM_AGGREGATES: readonly string[] = [
  "6669",   // inside Wistron
];

/**
 * Pairs CHECKED AND CLEARED - held, but not consolidated, so NOT double counts.
 *
 * Carried into the UI on purpose. The intuitive rule - a big stake means the
 * revenue is inside the parent's - is wrong here, and these are the counter
 * examples: stakes from 0.86% to 34.84%, none consolidating, against a 35-40%
 * stake that does. Showing them is what stops someone "fixing" a non-problem.
 */
export interface ClearedPair extends ConsolidationPair {
  treatment: string;
  stake: string;
  /** The document the treatment was read off. Rendered beside it. */
  asOf: string;
}

export const CLEARED: readonly ClearedPair[] = [
  { parent: "2303", child: "3037", parentName: "UMC", childName: "Unimicron", treatment: "equity_method", stake: "13.01%", asOf: "UMC FY2025 Form 20-F, Note 7" },
  { parent: "2303", child: "6147", parentName: "UMC", childName: "Chipbond", treatment: "fvoci", stake: "7.14% direct, ~8.95% including UMC's venture arm", asOf: "UMC FY2025 Form 20-F, Note (3)" },
  { parent: "2330", child: "3443", parentName: "TSMC", childName: "Global Unichip", treatment: "equity_method", stake: "34.84%", asOf: "GUC audited FY2025 statements, Note 28; TSMC 2024 annual report" },
  { parent: "2330", child: "5347", parentName: "TSMC", childName: "VIS", treatment: "equity_method", stake: "28% at FY2025, 27.6% at 2026-02-28, ~19% after the May 2026 sale", asOf: "TSMC FY2025 Form 20-F, Note 14 - superseded by the May 2026 sale" },
  { parent: "3231", child: "3661", parentName: "Wistron", childName: "Alchip", treatment: "fvoci", stake: "0.86%", asOf: "Wistron 2025 Q2 consolidated statements, Table 3" },
];

/**
 * Who sells into whom. A RISK-FLAGGING AID, NEVER A CAUSAL CLAIM - two
 * companies moving together may share a customer, a cycle, or nothing at all.
 * No figure on this dashboard is computed from an edge.
 *
 * `confidence` is not decoration and must be rendered. `high` means a source
 * NAMES the buyer - a customer list, a 20-F. `medium` means the supplier's
 * position is documented and the buyer is one of the assemblers that stage
 * sells into, but no disclosure pairs the two by name.
 */
export interface SupplyEdge {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  confidence: string;
  evidence: string;
}

export const SUPPLIES: readonly SupplyEdge[] = [
  { from: "3711", to: "2330", fromName: "ASE Technology", toName: "TSMC", confidence: "high", evidence: "ASE Technology Holding FY2025 Form 20-F: \"Since 1997, we have maintained a strategic alliance with TSMC, which designates us as their non-exclusive preferred provider of packaging and testing services for semiconductors manufactured by TSMC.\" TSMC's back-end packaging and test outsourcing ratio is reported rising from 18% (2024) toward 32% (2026) on CoWoS overflow. Note that much of the billing under that alliance goes to TSMC's customers rather than to TSMC, so the revenue link is weaker than the operational one." },
  { from: "3324", to: "2356", fromName: "Auras", toName: "Inventec", confidence: "high", evidence: "Same customer list, which names 英業達 (Inventec) explicitly among the downstream assembly ODMs Auras supplies." },
  { from: "3324", to: "2382", fromName: "Auras", toName: "Quanta", confidence: "high", evidence: "Auras' customer list, as carried in two independent analyst summaries, names 廣達 (Quanta) explicitly among the assembly ODMs it ships thermal modules and liquid cold plates to." },
  { from: "3324", to: "3231", fromName: "Auras", toName: "Wistron", confidence: "high", evidence: "Same customer list, which names 緯創 (Wistron) explicitly among the downstream assembly ODMs Auras supplies." },
  { from: "3680", to: "2330", fromName: "Gudeng", toName: "TSMC", confidence: "high", evidence: "Gudeng makes EUV reticle pods (>80% global share) and FOUP wafer carriers (~30%), and its published customer list is \"涵蓋台積電、英特爾、三星\". TSMC is the only EUV user in Taiwan, and Gudeng is one of a small number of ASML-certified pod suppliers." },
  { from: "1560", to: "2330", fromName: "Kinik", toName: "TSMC", confidence: "high", evidence: "Kinik is TSMC's principal CMP diamond-disc supplier - \"目前為台積電3nm與2nm的 主力供應商\" - reported at over 70% share at the 3nm node, having displaced the US incumbent as the largest 3nm supplier." },
  { from: "5434", to: "2330", fromName: "Topco Scientific", toName: "TSMC", confidence: "high", evidence: "Topco is the Shin-Etsu-system distributor in Taiwan for photoresist, silicon wafers, slurry, quartz and advanced-packaging materials, with over 50% of the domestic photoresist market. Semiconductors are 84%+ of its revenue and its stated customer list is \"主要客戶包括台積電、聯電、力積電、美光\"." },
  { from: "3017", to: "2317", fromName: "Asia Vital Components", toName: "Hon Hai", confidence: "medium", evidence: "AVC is the leading liquid cold-plate maker, reported near 50% share on GB300 and NVIDIA GB200/GB300 certified, with server and chassis at 66% of 1H25 revenue. Hon Hai is the largest rack integrator and a buyer of third-party cooling modules and chassis. Inferred from stage structure; not itemised in a disclosure." },
  { from: "3017", to: "2382", fromName: "Asia Vital Components", toName: "Quanta", confidence: "medium", evidence: "Same AVC position; Quanta is one of the four AI-server rack ODMs that buy those modules and chassis. Inferred from stage structure; not itemised in a disclosure." },
  { from: "3017", to: "3231", fromName: "Asia Vital Components", toName: "Wistron", confidence: "medium", evidence: "Same AVC position into Wistron's AI rack assembly. Inferred from stage structure; not itemised in a disclosure." },
  { from: "3017", to: "6669", fromName: "Asia Vital Components", toName: "Wiwynn", confidence: "medium", evidence: "Same AVC position into Wiwynn's CSP racks. The research pass that produced this one stated plainly that it is \"not itemised by name in a company disclosure - inferred from AI-rack supply-chain structure\", which is why it is medium and why that sentence is repeated here rather than dropped." },
  { from: "2308", to: "2317", fromName: "Delta Electronics", toName: "Hon Hai", confidence: "medium", evidence: "Delta is the leading AI-server power supplier, reported above 60% share of AI power in 2026, shipping PSUs, power shelves and busbars into GB200/GB300 racks. Hon Hai is the largest rack integrator and therefore among the buyers. Inferred from stage structure; not itemised in a disclosure." },
  { from: "2308", to: "2382", fromName: "Delta Electronics", toName: "Quanta", confidence: "medium", evidence: "Same Delta position. Quanta shipped roughly 6,100 GB200/GB300 racks in 2025, which consume merchant power shelves and 54V/800V PSUs. Inferred from stage structure; not itemised in a disclosure." },
  { from: "2308", to: "3231", fromName: "Delta Electronics", toName: "Wistron", confidence: "medium", evidence: "Same Delta position; Delta is named alongside 廣達/緯創/緯穎 in AI-rack supply chain reporting. Inferred from stage structure; not itemised in a disclosure." },
  { from: "2308", to: "6669", fromName: "Delta Electronics", toName: "Wiwynn", confidence: "medium", evidence: "Same Delta position; the same reporting groups 廣達、緯創、緯穎 as the assemblers consuming Delta and Lite-On power. Inferred from stage structure; not itemised in a disclosure." },
  { from: "2301", to: "2317", fromName: "Lite-On", toName: "Hon Hai", confidence: "medium", evidence: "Lite-On holds roughly 20-30% of the AI-server power-supply market and is the largest BBU module supplier, with 8.5kW PSUs, BBUs and 110kW power shelves in mass production for GB200/GB300 builds. It states it ships both to CSPs directly and to its main customers, so the ODM leg is partly structural. Inferred from stage structure; not itemised in a disclosure." },
  { from: "2301", to: "2382", fromName: "Lite-On", toName: "Quanta", confidence: "medium", evidence: "Same Lite-On position into Quanta's rack assembly. Inferred from stage structure; not itemised in a disclosure." },
  { from: "2301", to: "6669", fromName: "Lite-On", toName: "Wiwynn", confidence: "medium", evidence: "Same Lite-On position into Wiwynn's CSP rack builds. Inferred from stage structure; not itemised in a disclosure." },
];

/** One line a reader can act on, or null when nothing is excluded. */
export function consolidationNote(): string | null {
  if (CONSOLIDATION.length === 0) return null;
  const parts = CONSOLIDATION.map(
    (c) => `${c.childName} (${c.child}) is already inside ${c.parentName} (${c.parent})`,
  );
  return (
    `${parts.join("; ")} — so totals across companies count it once. ` +
    `Each company's own figures are unaffected.`
  );
}
