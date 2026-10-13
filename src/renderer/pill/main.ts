import { renderPill } from "./render.ts";

// The status pill's page (M23). Plain DOM, no React: it draws whatever main last sent and
// forwards clicks. It keeps no state, so there is nothing here that can be stale.
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
});
