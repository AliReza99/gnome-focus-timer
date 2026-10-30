import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const PRESETS = [10, 15, 25, 30, 45, 60];
const MAX_TITLE = 25;
const MAX_RECENT = 5;
const BAR_WIDTH = 280;
// Saved to disk so a running timer survives screen lock (shell disables extensions there) and restarts.
const STATE_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'focus-timer.json']);

const fmtMin = ms => `${Math.max(1, Math.ceil(ms / 60000))}m`;
const short = t => (t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t);

function loadState() {
    try {
        const [, bytes] = GLib.file_get_contents(STATE_FILE);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return {};
    }
}

export default class FocusTimerExtension extends Extension {
    enable() {
        // timer: {title, total, end, remaining (set when paused), done}
        const saved = loadState();
        this._timer = saved.timer ?? null;
        this._recent = saved.recent ?? [];

        this._button = new PanelMenu.Button(0.5, 'Focus Timer');
        this._label = new St.Label({text: '⏱', y_align: Clutter.ActorAlign.CENTER, style_class: 'focus-timer-label'});
        this._button.add_child(this._label);
        this._button.menu.connect('open-state-changed', (_m, open) => {
            // Clear on close: shrinking the label mid-click moves the button and closes the menu.
            if (!open) {
                if (this._timer?.done)
                    this._stop();
                return;
            }
            this._buildMenu();
        });
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
        // An empty PopupMenu refuses to open, so populate it up front.
        this._buildMenu();

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick();
    }

    disable() {
        GLib.source_remove(this._tickId);
        this._button.destroy();
        this._button = this._label = this._barFill = this._currentLabel = null;
    }

    _save() {
        GLib.file_set_contents(STATE_FILE, JSON.stringify({timer: this._timer, recent: this._recent}));
    }

    _left() {
        const t = this._timer;
        return t.remaining ?? t.end - Date.now();
    }

    _start(title, minutes) {
        if (!(minutes > 0))
            return;
        title = title.trim();
        const total = minutes * 60000;
        this._timer = {title, total, end: Date.now() + total, remaining: null, done: false};
        if (title) {
            this._recent = [{title, minutes}, ...this._recent.filter(r => r.title !== title)].slice(0, MAX_RECENT);
        }
        this._save();
        this._button.menu.close();
        this._tick();
    }

    _stop() {
        this._timer = null;
        this._save();
        this._label.remove_all_transitions();
        this._label.opacity = 255;
        this._tick();
    }

    _togglePause() {
        const t = this._timer;
        if (t.remaining === null) {
            t.remaining = t.end - Date.now();
        } else {
            t.end = Date.now() + t.remaining;
            t.remaining = null;
        }
        this._save();
        this._buildMenu();
        this._tick();
    }

    _add5() {
        const t = this._timer;
        t.total += 300000;
        if (t.remaining === null)
            t.end += 300000;
        else
            t.remaining += 300000;
        this._save();
        this._tick();
    }

    _finish() {
        const t = this._timer;
        t.done = true;
        this._save();
        const what = t.title || 'Timer';
        Main.notify(`Time's up: ${what}`, `${Math.round(t.total / 60000)} min done`);
        global.display.get_sound_player().play_from_theme('complete', 'Focus timer done', null);
        this._label.ease({
            opacity: 110, duration: 750, autoReverse: true, repeatCount: 5,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });
    }

    _tick() {
        const t = this._timer;
        const l = this._label;
        l.remove_style_class_name('focus-timer-paused');
        l.remove_style_class_name('focus-timer-done');
        if (!t) {
            l.text = '⏱';
            return;
        }
        if (!t.done && this._left() <= 0)
            this._finish();
        const name = t.title ? `${short(t.title)} · ` : '';
        if (t.done) {
            l.text = `✓ ${name}done`;
            l.add_style_class_name('focus-timer-done');
        } else if (t.remaining !== null) {
            l.text = `⏸ ${name}${fmtMin(t.remaining)}`;
            l.add_style_class_name('focus-timer-paused');
        } else {
            l.text = `⏱ ${name}${fmtMin(this._left())}`;
        }
        if (this._currentLabel && !t.done) {
            this._currentLabel.text = `${t.title || 'Timer'}: ${fmtMin(this._left())} left`;
            this._barFill.width = Math.round(BAR_WIDTH * Math.min(1, 1 - this._left() / t.total));
        }
    }

    _caption(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.add_style_class_name('focus-timer-caption');
        this._button.menu.addMenuItem(item);
    }

    _boxItem() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        item.add_child(box);
        this._button.menu.addMenuItem(item);
        return box;
    }

    _btn(label, cb) {
        const b = new St.Button({label, style_class: 'button focus-timer-btn', can_focus: true});
        b.connect('clicked', cb);
        return b;
    }

    _buildMenu() {
        const menu = this._button.menu;
        menu.removeAll();
        this._currentLabel = this._barFill = null;
        const t = this._timer;

        if (t) {
            this._caption('Current');
            const box = this._boxItem();
            this._currentLabel = new St.Label({style_class: 'focus-timer-current'});
            const bar = new St.Widget({style_class: 'focus-timer-bar'});
            this._barFill = new St.Widget({style_class: 'focus-timer-bar-fill'});
            bar.add_child(this._barFill);
            const row = new St.BoxLayout({style: 'spacing: 6px; margin-top: 8px;'});
            row.add_child(this._btn(t.remaining === null ? '⏸ Pause' : '▶ Resume', () => this._togglePause()));
            row.add_child(this._btn('+5 min', () => this._add5()));
            row.add_child(this._btn('■ Stop', () => {
                this._stop();
                this._buildMenu();
            }));
            box.add_child(this._currentLabel);
            box.add_child(bar);
            box.add_child(row);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        this._caption('New timer');
        const box = this._boxItem();
        const title = new St.Entry({hint_text: 'Title (optional)', can_focus: true, style_class: 'focus-timer-entry'});
        const mins = new St.Entry({hint_text: 'Minutes (Enter to start)', can_focus: true, style_class: 'focus-timer-entry', style: 'margin-top: 6px;'});
        mins.clutter_text.connect('activate', () => this._start(title.text, parseFloat(mins.text)));
        title.clutter_text.connect('activate', () => mins.grab_key_focus());
        const presets = new St.BoxLayout({style: 'spacing: 6px; margin-top: 8px;'});
        for (const m of PRESETS)
            presets.add_child(this._btn(`${m}`, () => this._start(title.text, m)));
        presets.add_child(this._btn('▶ Start', () => this._start(title.text, parseFloat(mins.text))));
        box.add_child(title);
        box.add_child(mins);
        box.add_child(presets);

        if (this._recent.length) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._caption('Recent');
            for (const r of this._recent) {
                const item = menu.addAction(`${r.title} · ${r.minutes}m`, () => this._start(r.title, r.minutes));
                item.label.x_expand = true;
                item.add_child(this._btn('✕', () => {
                    this._recent = this._recent.filter(x => x !== r);
                    this._save();
                    this._buildMenu();
                }));
            }
        }

        this._tick();
        // Defer: focus can't be grabbed until the menu is mapped.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (title.get_stage())
                title.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }
}
