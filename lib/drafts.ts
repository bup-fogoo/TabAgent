/** Shared drafts use a revision check under a browser-wide lock; an unsaved local
 * branch survives reloads and is never overwritten by another panel's draft. */
const PREFIX = 'tabagent:draft:v2:';
const LEGACY = 'tabagent:panel-draft';
interface RecordValue { revision: string; text: string; writer: string; deleted?: boolean }
interface DraftState { id: string; base: RecordValue; text: string; dirty: boolean; conflict: boolean }
const blank = (): RecordValue => ({ revision: '', text: '', writer: '' });

export class DraftStore {
  private owner: string;
  private states = new Map<string, DraftState>();
  private current = '';
  private queue: Promise<void> = Promise.resolve();
  private ownerReady: Promise<void>;
  constructor(private changed: (text: string, conflict: boolean, remote: string) => void) {
    // A duplicated tab can inherit sessionStorage, so every live panel needs a
    // fresh branch identity. open() also discovers recovery branches after reload.
    this.owner = crypto.randomUUID();
    this.ownerReady = new Promise((ready) => {
      if (!navigator.locks) { ready(); return; }
      void navigator.locks.request(`tabagent-draft-owner:${this.owner}`, async () => {
        ready();
        await new Promise<void>((release) => window.addEventListener('pagehide', () => release(), { once: true }));
      }).catch(() => ready());
    });
    window.addEventListener('storage', (event) => {
      if (event.key !== `${PREFIX}${this.current}`) return;
      const state = this.states.get(this.current);
      if (!state) return;
      this.refresh(state);
    });
  }
  private read(id: string): RecordValue {
    try {
      const raw = localStorage.getItem(`${PREFIX}${id}`);
      if (raw) {
        const value = JSON.parse(raw);
        if (typeof value?.revision === 'string' && typeof value.text === 'string') return value;
      }
      return { ...blank(), text: localStorage.getItem(`${LEGACY}:${id}`) ?? '' };
    } catch { return blank(); }
  }
  private branchKey(id: string) { return `${PREFIX}branch:${id}:${this.owner}`; }
  private notify(state: DraftState) {
    if (this.current === state.id) this.changed(state.text, state.conflict, this.read(state.id).text);
  }
  private refresh(state: DraftState) {
    const remote = this.read(state.id);
    if (remote.deleted) {
      state.base = remote; state.text = ''; state.dirty = state.conflict = false;
      try { localStorage.removeItem(this.branchKey(state.id)); } catch { /* Optional recovery. */ }
    } else if (state.dirty && state.text !== remote.text && state.base.revision !== remote.revision) {
      state.conflict = true;
    } else if (!state.dirty || state.text === remote.text) {
      state.base = remote; state.text = remote.text; state.dirty = state.conflict = false;
      try { localStorage.removeItem(this.branchKey(state.id)); } catch { /* Optional recovery cleanup. */ }
    }
    this.notify(state);
  }
  open(id: string, fallback = '') {
    this.current = id;
    let state = this.states.get(id);
    if (!state) {
      const base = this.read(id);
      state = { id, base, text: base.text || fallback, dirty: !base.text && Boolean(fallback), conflict: false };
      this.states.set(id, state);
      this.notify(state);
      if (state.dirty || (!base.text && fallback)) this.edit(state.text);
      else this.recover(state);
    } else this.refresh(state);
  }
  private recover(state: DraftState) {
    // Only claim branches whose owning panel is gone. Browser-managed lifetime
    // locks release even after a crash; another live panel's edits remain its own.
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.ownerReady;
      const prefix = `${PREFIX}branch:${state.id}:`;
      for (const key of Object.keys(localStorage).filter((key) => key.startsWith(prefix))) {
        if (state.dirty || state.base.deleted) return;
        const adopt = () => {
          const branch = JSON.parse(localStorage.getItem(key) || 'null');
          if (!branch || typeof branch.text !== 'string' || !branch.base || state.dirty) return false;
          const remote = this.read(state.id);
          if (remote.deleted) return false;
          state.text = branch.text; state.base = branch.base; state.dirty = true;
          state.conflict = branch.base.revision !== remote.revision && branch.text !== remote.text;
          localStorage.setItem(this.branchKey(state.id), JSON.stringify(branch));
          localStorage.removeItem(key);
          this.notify(state);
          this.edit(state.text);
          return true;
        };
        const recovered = navigator.locks
          ? await navigator.locks.request(`tabagent-draft-owner:${key.slice(prefix.length)}`, { ifAvailable: true }, (lock) => lock ? adopt() : false)
          : adopt();
        if (recovered) return;
      }
    }).catch(() => { /* A recovery branch stays intact if it cannot be read. */ });
  }
  preview(id: string) { return this.states.get(id)?.text ?? this.read(id).text; }
  hasSaved(id: string) { return Boolean(this.read(id).revision); }
  private async locked<T>(id: string, work: () => T | Promise<T>): Promise<T> {
    // Without Web Locks, preserve the per-panel branch and never race a shared write.
    if (!navigator.locks) return await work();
    return await navigator.locks.request(`tabagent-draft:${id}`, async () => await work());
  }
  edit(text: string) {
    const state = this.states.get(this.current);
    if (!state || state.base.deleted || (state.text === text && !state.dirty)) return;
    state.text = text; state.dirty = true;
    try { localStorage.setItem(this.branchKey(state.id), JSON.stringify({ text, base: state.base })); } catch { /* Keep the visible draft. */ }
    this.queue = this.queue.catch(() => {}).then(async () => { await this.ownerReady; return this.locked(state.id, () => {
      if (!state.dirty) return;
      const remote = this.read(state.id);
      if (remote.deleted) { this.refresh(state); return; }
      if (!navigator.locks || (remote.revision !== state.base.revision && remote.text !== state.base.text && remote.text !== state.text)) {
        state.conflict = true; this.notify(state); return;
      }
      const next: RecordValue = { revision: crypto.randomUUID(), text: state.text, writer: this.owner };
      localStorage.setItem(`${PREFIX}${state.id}`, JSON.stringify(next));
      localStorage.removeItem(this.branchKey(state.id));
      localStorage.removeItem(`${LEGACY}:${state.id}`);
      state.base = next; state.dirty = state.conflict = false;
      this.notify(state);
    }); }).catch(() => { /* A failed shared write leaves the local recovery branch intact. */ });
  }
  resolve(useLocal: boolean) {
    const state = this.states.get(this.current);
    if (!state) return;
    const remote = this.read(state.id);
    if (remote.deleted) { this.refresh(state); return; }
    state.base = remote; state.conflict = false;
    if (useLocal) { state.dirty = true; this.edit(state.text); }
    else {
      state.text = remote.text; state.dirty = false;
      try { localStorage.removeItem(this.branchKey(state.id)); } catch { /* Optional recovery. */ }
      this.notify(state);
    }
  }
  remove(id: string) {
    return this.locked(id, () => {
      localStorage.setItem(`${PREFIX}${id}`, JSON.stringify({ revision: crypto.randomUUID(), writer: this.owner, text: '', deleted: true }));
      localStorage.removeItem(`${LEGACY}:${id}`);
      for (const key of Object.keys(localStorage)) if (key.startsWith(`${PREFIX}branch:${id}:`)) localStorage.removeItem(key);
      const state = this.states.get(id);
      if (state) this.refresh(state);
    }).catch(() => {});
  }
  flush() { return this.queue; }
}
