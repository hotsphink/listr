import { type Component, createMemo, createSignal, createEffect, onCleanup, Show } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { db } from "../db/database.js";
import { decodeShareToken } from "../sync/shareToken.js";
import { setSidebarOpen } from "../store/sidebarStore.js";

const ReceivePage: Component = () => {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();

  const payload = createMemo(() => decodeShareToken(params.token));

  const [saving, setSaving] = createSignal(false);
  const [accepted, setAccepted] = createSignal(false);
  const [boardId, setBoardId] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  // Once the user accepts, watch for the specific board to land in the DB.
  // We know its ID from the share payload, so we can watch directly rather than
  // scanning all boards.
  createEffect(() => {
    if (!accepted()) return;
    const p = payload();
    if (!p?.bid) {
      // No board ID in payload (bare-key share) — just go home and let it appear
      setSidebarOpen(true);
      navigate("/");
      return;
    }
    const sub = liveQuery(() => db.boards.get(p.bid)).subscribe((board) => {
      if (board) {
        setBoardId(board.id);
        sub.unsubscribe();
      }
    });
    onCleanup(() => sub.unsubscribe());
  });

  const accept = async () => {
    const p = payload();
    if (!p) return;
    setSaving(true);
    setSaveError(null);
    try {
      await db.shared_keys.put({ key: p.sk, added_at: Date.now(), board_name: p.bn || undefined });
      setAccepted(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const viewBoard = () => {
    setSidebarOpen(true);
    navigate(`/board/${boardId()}`);
  };

  return (
    <div class="main receive-page">
      <Show
        when={payload()}
        fallback={
          <div class="receive-card">
            <h2>Invalid share link</h2>
            <p class="field-hint">This link doesn't look like a valid Listr board share.</p>
            <button class="btn-primary" type="button" onClick={() => navigate("/")}>Go home</button>
          </div>
        }
      >
        {(p) => (
          <div class="receive-card">
            <Show when={!accepted()} fallback={
              <Show
                when={boardId()}
                fallback={
                  <div class="receive-syncing">
                    <div class="receive-spinner" />
                    <div>Syncing board…</div>
                    <div class="field-hint" style="margin-top: 8px">Waiting for data from server</div>
                  </div>
                }
              >
                <div class="receive-saved">
                  <div class="receive-saved-icon">✓</div>
                  <div>Board is ready</div>
                </div>
                <div class="receive-actions">
                  <button class="btn-primary" type="button" onClick={viewBoard}>View Board</button>
                </div>
              </Show>
            }>
              <h2>Board share</h2>
              <Show when={p().bn}>
                <div class="receive-board-name">"{p().bn}"</div>
              </Show>
              <p>Subscribe to this board and sync its data to your device?</p>
              <Show when={saveError()}>
                <div class="field-error">{saveError()}</div>
              </Show>
              <div class="receive-actions">
                <button class="btn-ghost" type="button" onClick={() => navigate("/")}>Cancel</button>
                <button class="btn-primary" type="button" disabled={saving()} onClick={accept}>
                  {saving() ? "Adding…" : "Add Board"}
                </button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
};

export default ReceivePage;
