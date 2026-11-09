// Command history: every edit is a serialisable command applied through one function, so undo/redo, logging and
// session replay all share one mechanism.
//
// Commands:  {op:'set', kind, id, before:{path:value}, after:{path:value}}
//            {op:'add', kind, rec, index}   {op:'delete', kind, rec, index}
//            {op:'review', id, before, after}
//            {op:'batch', cmds:[...]}
// Every command also carries `label` (for the UI) and `via` (handle, panel, nudge, snap_scan, key, ...).
export class History {
  constructor(apply, onChange) {
    this.apply = apply;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Run a command (or record one whose effect was already applied live, e.g. at the end of a drag). */
  exec(cmd, { applied = false } = {}) {
    if (!applied) this.apply(cmd, 'do');
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.onChange('do', cmd);
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.apply(cmd, 'undo');
    this.redoStack.push(cmd);
    this.onChange('undo', cmd);
    return cmd;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.apply(cmd, 'do');
    this.undoStack.push(cmd);
    this.onChange('redo', cmd);
    return cmd;
  }
}
