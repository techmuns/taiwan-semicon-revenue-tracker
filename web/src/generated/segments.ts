// GENERATED FILE - do not edit. Source: config/segments.yaml
//
// A segment is a NAMED SET OF COMPANIES, and its figure is the sum of their
// TOTAL revenue - NOT their revenue in that segment. Monthly filings carry no
// product split. Every surface that renders a segment must show `basis`.
//
// Regenerate with:  python -m twrev.cli validate --write

export interface Segment {
  key: string;
  label: string;
  /** What the figure actually measures. Render it; it is not optional prose. */
  basis: string;
  members: readonly string[];
  notes: string;
}

export const SEGMENTS: readonly Segment[] = [
  {
    key: "hpc",
    label: "High-performance compute",
    basis: "Total reported revenue of the companies below, not their HPC-only revenue. Monthly filings carry no product split; membership is an editorial call recorded in config/segments.yaml.",
    members: [
      "2330",   // TSMC
      "3443",   // Global Unichip
      "3661",   // Alchip
      "3711",   // ASE Technology
      "3037",   // Unimicron
      "8046",   // Nan Ya PCB
      "6669",   // Wiwynn
      "3231",   // Wistron
      "2382",   // Quanta
      "2345",   // Accton
      "3017",   // Asia Vital Components
      "2308",   // Delta Electronics
    ],
    notes: "Wiwynn (6669) is inside Wistron (3231) - see config/relationships.yaml. Both are listed because membership is a claim about which businesses belong to the theme; the AGGREGATE de-duplicates them, exactly as the universe total does, so listing both cannot inflate the figure.",
  },
];

/** Segment splits transcribed by hand from a named source. */
export interface SegmentObservation {
  ticker: string;
  segment: string;
  period: string;
  sharePct: number | null;
  revenueTwdThousands: number | null;
  source: string;
  asOf: string;
}

// Empty, and an empty list is the truthful state: no monthly filing in this
// pipeline contains a segment split. Populating it is a data-sourcing task
// against quarterly IFRS 8 notes, not a visualization task.
export const SEGMENT_OBSERVATIONS: readonly SegmentObservation[] = [
];
