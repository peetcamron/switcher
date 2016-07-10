// Switcher is a Gnome Shell extension allowing quickly switching windows by typing
// Copyright (C) 2015  Daniel Landau
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/*global imports, print */
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;
const Shell = imports.gi.Shell;
const Meta = imports.gi.Meta;
const GLib = imports.gi.GLib;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

const keyActivation = Me.imports.keyActivation.KeyActivation;
const switcher = Me.imports.modes.switcher.Switcher;
const launcher = Me.imports.modes.launcher.Launcher;

const orderByFocus     = 0;
const orderByRelevancy = 1;
const matchSubstring = 0;
const matchFuzzy     = 1;

let container, cursor;

function escapeChars(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
}

function makeFilter(mode, text) {
  return function(app) {
    // start from zero, filters can change this up or down
    // and the scores are summed
    app.score = 0;
    return text.split(' ').every(fragment => runFilter(mode, app, fragment));
  };
}

function runFilter(mode, app, fragment) {
  if (fragment == '')
    return true;

  fragment = escapeChars(fragment);
  
  const matching = Convenience.getSettings().get_uint('matching');
  const splitChar = (matching == matchFuzzy) ? '' : ' ';
  const specialexp = new RegExp(/[-[\]{}()*+?.,\\^$|#]/);
  const regexp = new RegExp(fragment.split(splitChar).reduce(function(a,b) {
      // In order to treat special charactes as a whole,
      // we manually identify and concatenate them
      if (b == '\\')
        return a+b;
      else if (specialexp.test(b) && (a.charAt(a.length - 1) == '\\'))
        return a.slice(0, a.length - 1) + '[^' + '\\' + b + ']*' + '\\' +  b;
      else
        return a + '[^' + b + ']*' + b;
  }), "gi");

  let match;
  let gotMatch = false;
  let score = 0;
  const descriptionLowerCase = mode.description(app).toLowerCase();
  const filteredDescription = escapeChars(descriptionLowerCase
          .slice(mode.descriptionNameIndex(app), descriptionLowerCase.length));
  // go through each match inside description
  while ((match = regexp.exec(filteredDescription))) {

    // A full match at the beginning is the best match
    if ((match.index == 0) && match[0].length == fragment.length) {
      score += 100;
    }

    // matches at beginning word boundaries are better than in the middle of words
    const wordPrefixFactor =
            (match.index == 0 || (match.index != 0) && filteredDescription.charAt(match.index - 1) == " ")
            ? 1.2 : 0.0;

    // matches nearer to the beginning are better than near the end
    const precedenceFactor = 1.0 / (1 + match.index);

    // fuzzyness can cause lots of stuff to match, penalize by match length
    const fuzzynessFactor = 2.3 * (fragment.length - match[0].length) / match[0].length;

    // join factors by summing
    const newscore = precedenceFactor + wordPrefixFactor + fuzzynessFactor;

    score = Math.max(score, newscore);

    gotMatch = true;
  }
  app.score += score;

  return gotMatch;
}

function highlightText(text, query) {
  // Don't apply highlighting if there's no input
  if (query == "")
    return text;

  // Identify substring parts to be highlighted
  const matching = Convenience.getSettings().get_uint('matching');
  let queryExpression = "(";
  let queries = (matching == matchFuzzy) ? query.split(/ |/) : query.split(" ");
  let queriesLength = queries.length;
  for (let i = 0; i < queriesLength - 1; i++) {
    if (queries[i] != "") {
      queryExpression += escapeChars(queries[i]) + "|";
    }
  }
  queryExpression += escapeChars(queries[queriesLength - 1]) + ")";

  let queryRegExp = new RegExp(queryExpression, "i");
  let tokenRegExp = new RegExp("^" + queryExpression + "$", "i");

  // Build resulting string from highlighted and non-highlighted strings
  let result = "";
  let tokens = text.split(queryRegExp);
  let tokensLength = tokens.length;
  for (let i = 0; i < tokensLength; i++) {
    if (tokens[i].match(tokenRegExp)) {
      result += '<u><span underline_color=\"#4a90d9\" foreground=\"#ffffff\">' +
                tokens[i] +
                '</span></u>';
    } else {
      result += tokens[i];
    }
  }

  return result.replace(/&/g, "&amp;");
}

function updateHighlight(boxes, query) {
  boxes.forEach(box => {
    box.whole.remove_style_class_name('switcher-highlight');

    const highlightedText = highlightText(box.label.get_text(), query);
    box.label.clutter_text.set_markup(highlightedText);
  });

  boxes.length > cursor &&
      boxes[cursor].whole.add_style_class_name('switcher-highlight');
}

function _showUI(mode, entryText) {
  'use strict';
  if (container)
    return;

  cursor = 0;

  const debouncedActivateUnique = debounce(() => {
    if (filteredApps.length === 1) {
      cleanUI();
      mode.activate(filteredApps[cursor]);
    }
  }, Convenience.getSettings().get_uint('activate-after-ms'));

  const filterByText = function(mode, apps, text) {
      let filteredApps = apps.filter(makeFilter(mode, text));

      // Always preserve focus order before typing
      const ordering = Convenience.getSettings().get_uint('ordering');
      if ((ordering == orderByRelevancy) && text != "") {
        filteredApps = filteredApps.sort(function(a, b) {
          if (a.score > b.score)
            return -1;
          if (a.score < b.score)
            return 1;
          return 0;
        });
      }

      if (Convenience.getSettings().get_boolean('activate-immediately') &&
          filteredApps.length === 1) {
        debouncedActivateUnique();
      }

      return filteredApps;
  };

  const cleanBoxes = function() {
    boxes.forEach(box => {
        box.iconBox.get_children().forEach(child => 
            mode.destroyParent(child));
        box.iconBox.destroy();
        boxLayout.remove_child(box.whole);
    });
  };

  const cleanUI = function() {
    cleanBoxes();
    Main.uiGroup.remove_actor(container);
    Main.popModal(container);
    container = null;
  };

  container = new St.Bin({reactive: true});
  container.set_alignment(St.Align.MIDDLE, St.Align.START);

  const fontSize = Convenience.getSettings().get_uint('font-size');
  let boxLayout = new St.BoxLayout({style_class: 'switcher-box-layout'});
  boxLayout.set_style('font-size: ' + fontSize + 'px');
  boxLayout.set_vertical(true);

  const apps = mode.apps();
  let filteredApps = filterByText(mode, apps, entryText);

  let boxes = filteredApps.slice(0,mode.MAX_NUM_ITEMS).map(mode.makeBox);
  updateHighlight(boxes, entryText);

  let entry =
    new St.Entry({style_class: 'switcher-entry', hint_text: 'type filter'});
  entry.set_text(entryText);
  boxLayout.insert_child_at_index(entry, 0);
  boxes.forEach((box) => boxLayout.insert_child_at_index(box.whole, -1));

  container.add_actor(boxLayout);
  Main.uiGroup.add_actor(container);

  let monitor = Main.layoutManager.primaryMonitor;
  container.set_width(monitor.width);
  container.set_height(monitor.height);
  container.set_position(monitor.x, monitor.y);

  let width =
      boxes.map(box => box.whole.width)
           .reduce((a, b) => Math.max(a, b), 0);
  let shortcutWidth =
      boxes.map(box => box.shortcutBox ? box.shortcutBox.width : 0)
           .reduce((a, b) => Math.max(a, b), 0);
  const maxWidth = Main.layoutManager.primaryMonitor.width * 0.01 *
                   Convenience.getSettings().get_uint('max-width-percentage');
  if (width > maxWidth)
    width = maxWidth;
  if (width < maxWidth/2)
    width = maxWidth/2;
  boxes.forEach(box => fixWidths(box, width, shortcutWidth));
  entry.set_width(width);

  entry.connect('key-release-event', (o, e) => {
    const control = (e.get_state() & Clutter.ModifierType.CONTROL_MASK) != 0;
    const shift = (e.get_state() & Clutter.ModifierType.SHIFT_MASK) != 0;
    const symbol = e.get_key_symbol();
    let fkeyIndex = keyActivation.getActionKeyTable().indexOf(symbol);

    // Exit
    if (symbol === Clutter.KEY_Escape) {
      cleanUI();
      entry.set_text("");

    // Switch mode
    } else if (((symbol === Clutter.m) && control) ||
        ((symbol === Clutter.KEY_Tab) && control) ||
        ((symbol === Clutter.KEY_space) && control)) {
        let previousText = entry.get_text();
        cleanUI();
        (mode.name() === "Switcher")
          ? _showUI(launcher, previousText)
          : _showUI(switcher, previousText);

    // Activate selected entry
    } else if ((symbol === Clutter.KEY_Return) ||
        ((symbol === Clutter.j) && control)) {
      cleanUI();
      filteredApps.length > 0 && mode.activate(filteredApps[cursor]);

    // Activate entry by shortcut
    } else if (fkeyIndex >= 0 && fkeyIndex < filteredApps.length) {
      cleanUI();
      mode.activate(filteredApps[fkeyIndex]);

    // Next entry
    } else if ((symbol === Clutter.KEY_Down) ||
        (symbol === Clutter.KEY_Tab) ||
        ((symbol === Clutter.n) && control)) {
      cursor = cursor + 1 < boxes.length ? cursor + 1 : 0;
      updateHighlight(boxes, o.text);

    // Previous entry
    } else if ((symbol === Clutter.KEY_Up) || 
        ((symbol === Clutter.ISO_Left_Tab) && shift) ||
        ((symbol === Clutter.KEY_Tab) && shift) ||
        ((symbol === Clutter.p) && control)) {
      cursor = cursor > 0 ? cursor - 1 : boxes.length - 1;
      updateHighlight(boxes, o.text);

    // Filter text
    } else {
      // Delete last character
      if ((symbol === Clutter.h) && control) {
        const entryText = entry.get_clutter_text();
        let textCursor = entryText.get_cursor_position();
        if (textCursor == -1)
          textCursor = o.text.length;
        entryText.delete_text(textCursor - 1, textCursor);
      }

      filteredApps = filterByText(mode, apps, o.text);

      cleanBoxes();
      boxes = filteredApps.slice(0,mode.MAX_NUM_ITEMS).map(mode.makeBox);
      
      // If there's less boxes then in previous cursor position,
      // set cursor to the last box
      if (cursor + 1 > boxes.length)
        cursor = Math.max(boxes.length - 1, 0);

      updateHighlight(boxes, o.text);
      boxes.forEach((box) => {
        fixWidths(box, width, shortcutWidth);
        boxLayout.insert_child_at_index(box.whole, -1);
      });
    }
  });

  Main.pushModal(container);
  container.connect('button-press-event', cleanUI);
  global.stage.set_key_focus(entry);
  container.show();
}

function fixWidths(box, width, shortcutWidth) {
  box.whole.set_width(width);
  box.shortcutBox && box.shortcutBox.set_width(shortcutWidth);
}

function init() {
}

function enable() {
  // Since Gnome 3.16, Shell.KeyBindingMode is replaced by Shell.ActionMode
  Main.wm.addKeybinding(
      'show-switcher', Convenience.getSettings(), Meta.KeyBindingFlags.NONE,
      Shell.KeyBindingMode ? Shell.KeyBindingMode.NORMAL
                           : Shell.ActionMode.NORMAL,
      () => _showUI(switcher, ""));
  Main.wm.addKeybinding(
      'show-launcher', Convenience.getSettings(), Meta.KeyBindingFlags.NONE,
      Shell.KeyBindingMode ? Shell.KeyBindingMode.NORMAL
                           : Shell.ActionMode.NORMAL,
      () => _showUI(launcher, ""));
}

function disable() { 
  Main.wm.removeKeybinding('show-switcher');
  Main.wm.removeKeybinding('show-launcher');
}

// from https://github.com/satya164/gjs-helpers
const setTimeout = (f, ms) => {
  return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    f();

    return false; // Don't repeat
  }, null);
};

const clearTimeout = id => GLib.Source.remove(id);

function debounce(f, ms) {
  let timeoutId = null;
  return function() {
    if (timeoutId)
      clearTimeout(timeoutId);
    timeoutId = setTimeout(f, ms);
  };
}
