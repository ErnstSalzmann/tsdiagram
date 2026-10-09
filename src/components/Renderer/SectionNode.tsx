import { memo } from "react";

export type SectionNodeProps = { data: { title: string } };

/** The labeled boundary behind the nodes of one section. `buildSectionNodes` sizes it. */
export const SectionNode = memo(({ data }: SectionNodeProps) => (
  <div className="section-node">
    <div className="section-node-title">{data.title}</div>
  </div>
));
SectionNode.displayName = "SectionNode";
