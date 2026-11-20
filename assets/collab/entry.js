// Growth Hub notes co-editing bundle (Nov 20 2026): Yjs + Quill 2 + y-quill + quill-cursors + awareness.
import * as Y from 'yjs';
import Quill from 'quill';
import QuillCursors from 'quill-cursors';
import { QuillBinding } from 'y-quill';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
Quill.register('modules/cursors', QuillCursors);
window.GHCollab = { Y, Quill, QuillCursors, QuillBinding, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates };
