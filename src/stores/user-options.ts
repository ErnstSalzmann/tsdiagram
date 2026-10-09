import { createStore, useStore } from "statelift";
import { z } from "zod";

const userOptionsSchema = z.object({
  general: z.object({
    sidebarOpen: z.boolean().default(true),
  }),
  panels: z.object({
    splitDirection: z.enum(["horizontal", "vertical"]).default("horizontal"),
  }),
  editor: z.object({
    editingMode: z.enum(["default", "vim"]).default("default"),
  }),
  renderer: z.object({
    direction: z.enum(["horizontal", "vertical"]).default("horizontal"),
    autoFitView: z.boolean().default(true),
    theme: z.enum(["light", "dark"]).default("light"),
    enableMinimap: z.boolean().default(true),
    badgeHubs: z.boolean().default(true),
    collapseLeaves: z.boolean().default(true),
    compactLayout: z.boolean().default(true),
    colorizeEdges: z.boolean().default(true),
    sections: z.boolean().default(true),
    view: z.enum(["all", "functions"]).default("all"),
  }),
});

const rendererSchema = userOptionsSchema.shape.renderer.shape;

/** The renderer options from the query string, for example `?view=functions&direction=vertical`. */
const readQueryRendererOptions = () => {
  const result: { view?: "all" | "functions"; direction?: "horizontal" | "vertical" } = {};
  if (typeof location === "undefined") return result;
  const query = new URLSearchParams(location.search);
  const view = rendererSchema.view.safeParse(query.get("view"));
  if (view.success) result.view = view.data;
  const direction = rendererSchema.direction.safeParse(query.get("direction"));
  if (direction.success) result.direction = direction.data;
  return result;
};

export type UserOptions = z.infer<typeof userOptionsSchema> & {
  load: () => void;
  save: () => void;
};
export const optionsStore = createStore<UserOptions>({
  general: {
    sidebarOpen: false,
  },
  panels: {
    splitDirection: "horizontal",
  },
  editor: {
    editingMode: "default",
  },
  renderer: {
    direction: "horizontal",
    autoFitView: true,
    theme: "light",
    enableMinimap: true,
    badgeHubs: true,
    collapseLeaves: true,
    compactLayout: true,
    colorizeEdges: true,
    sections: true,
    view: "all",
  },
  load() {
    try {
      const data = JSON.parse(localStorage.getItem("options") ?? "");
      const parsedData = userOptionsSchema.parse(data);
      parsedData.renderer.autoFitView = true;
      Object.assign(this, parsedData);
    } catch {}
    // a query parameter wins over the stored options, so a link or the CLI can pick a view
    Object.assign(this.renderer, readQueryRendererOptions());
  },
  save() {
    localStorage.setItem(
      "options",
      JSON.stringify({
        general: this.general,
        panels: this.panels,
        editor: this.editor,
        renderer: this.renderer,
      })
    );
  },
});
optionsStore.state.load();
export const useUserOptions = () => useStore(optionsStore);
