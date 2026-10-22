import { renderPill, reportMeasurements } from "./render.ts";

// The status pill's page (M23). Plain DOM, no React: it draws whatever main last sent and
// forwards clicks. It keeps no state, so there is nothing here that can be stale — whether the
// list is open is main's to say, on every view.
const root = document.getElementById("pill");
if (!root) {
  throw new Error("pill element not found");
}

window.pill.onView((view) => {
  renderPill(root, view, {
    onAction: (id, action) => window.pill.action(id, action),
    onExpand: (expanded) => window.pill.expand(expanded),
    onMute: (muted) => window.pill.mute(muted),
  });
  // Tell main how tall the open list and how wide each label really is, so the window fits
  // them (render.ts, where it can be tested).
  reportMeasurements(root, view, {
    contentHeight: (height) => window.pill.contentHeight(height),
    labelWidths: (labels, widths) => window.pill.labelWidths(labels, widths),
  });
});

// The window cannot take focus, so it never blurs. Where the pointer is stands in for it:
// main closes an open list ten seconds after the pointer leaves, and not while it is here.
document.documentElement.addEventListener("mouseenter", () => window.pill.hover(true));
document.documentElement.addEventListener("mouseleave", () => window.pill.hover(false));
