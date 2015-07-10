/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
'use strict';

module.metadata = {
  "stability": "unstable"
};

const { Cc, Ci, Cu } = require('chrome');
const { on } = require('../system/events');
const { id, preferencesBranch } = require('../self');
const { localizeInlineOptions } = require('../l10n/prefs');
const { AddonManager } = Cu.import("resource://gre/modules/AddonManager.jsm");
const { defer } = require("sdk/core/promise");

const HTML_NS = "http://www.w3.org/1999/xhtml";

const DEFAULT_OPTIONS_URL = 'data:text/xml,<placeholder/>';

const VALID_PREF_TYPES = ['bool', 'boolint', 'integer', 'string', 'color',
                          'file', 'directory', 'control', 'menulist', 'multiple-select', 'radio'];

function enable({ preferences, id }) {
  let enabled = defer();

  validate(preferences);

  setDefaults(preferences, preferencesBranch);

  // allow the use of custom options.xul
  AddonManager.getAddonByID(id, (addon) => {
    on('addon-options-displayed', onAddonOptionsDisplayed, true);
    enabled.resolve({ id: id });
  });

  function onAddonOptionsDisplayed({ subject: doc, data }) {
    if (data === id) {
      let parent = doc.getElementById('detail-downloads').parentNode;
      injectOptions({
        preferences: preferences,
        preferencesBranch: preferencesBranch,
        document: doc,
        parent: parent,
        id: id
      });
      localizeInlineOptions(doc);
    }
  }

  return enabled.promise;
}
exports.enable = enable;

// centralized sanity checks
function validate(preferences) {
  for (let { name, title, type, label, options } of preferences) {
    // make sure the title is set and non-empty
    if (!title)
      throw Error("The '" + name + "' pref requires a title");

    // make sure that pref type is a valid inline option type
    if (!~VALID_PREF_TYPES.indexOf(type))
      throw Error("The '" + name + "' pref must be of valid type");

    // if it's a control, make sure it has a label
    if (type === 'control' && !label)
      throw Error("The '" + name + "' control requires a label");

    // if it's a menulist or radio, make sure it has options
    if (type === 'menulist' || type === 'multiple-select' || type === 'radio') {
      if (!options)
        throw Error("The '" + name + "' pref requires options");

      // make sure each option has a value and a label
      for (let item of options) {
        if (!('value' in item) || !('label' in item))
          throw Error("Each option requires both a value and a label");
      }
    }

    // TODO: check that pref type matches default value type
  }
}
exports.validate = validate;

// initializes default preferences, emulates defaults/prefs.js
function setDefaults(preferences, preferencesBranch) {
  const branch = Cc['@mozilla.org/preferences-service;1'].
                 getService(Ci.nsIPrefService).
                 getDefaultBranch('extensions.' + preferencesBranch + '.');
  for (let { name, value } of preferences) {
    switch (typeof value) {
      case 'boolean':
        branch.setBoolPref(name, value);
        break;
      case 'number':
        // must be integer, ignore otherwise
        if (value % 1 === 0) {
          branch.setIntPref(name, value);
        }
        break;
      case 'string':
        let str = Cc["@mozilla.org/supports-string;1"].
                  createInstance(Ci.nsISupportsString);
        str.data = value;
        branch.setComplexValue(name, Ci.nsISupportsString, str);
        break;
      case 'object':
        if (value) {
          let str = Cc["@mozilla.org/supports-string;1"].
                    createInstance(Ci.nsISupportsString);
          str.data = JSON.stringify(value);
          branch.setComplexValue(name, Ci.nsISupportsString, str);
        }
    }
  }
}
exports.setDefaults = setDefaults;

// dynamically injects inline options into about:addons page at runtime
function injectOptions({ preferences, preferencesBranch, document, parent, id }) {
  const branch = Cc['@mozilla.org/preferences-service;1'].
                 getService(Ci.nsIPrefService).
                 getBranch('extensions.' + preferencesBranch + '.');
  function saveTags (name, ul) {
    var tags = $(ul).tagit('tags'); // array of objects representing tags
    let str = Cc["@mozilla.org/supports-string;1"].
              createInstance(Ci.nsISupportsString);
    str.data = JSON.stringify(tags);
    branch.setComplexValue(name, Ci.nsISupportsString, str);
  }
  for (let { name, type, hidden, title, description, label, options, on, off, open } of preferences) {

    if (hidden) {
      continue;
    }

    let setting = document.createElement('setting');
    setting.setAttribute('pref-name', name);
    setting.setAttribute('data-jetpack-id', id);
    setting.setAttribute('pref', 'extensions.' + preferencesBranch + '.' + name);
    setting.setAttribute('type', type);
    setting.setAttribute('title', title);
    if (description)
      setting.setAttribute('desc', description);

    if (type === 'file' || type === 'directory') {
      setting.setAttribute('fullpath', 'true');
    }
    else if (type === 'control') {
      let button = document.createElement('button');
      button.setAttribute('pref-name', name);
      button.setAttribute('data-jetpack-id', id);
      button.setAttribute('label', label);
      button.setAttribute('oncommand', "Services.obs.notifyObservers(null, '" +
                                        id + "-cmdPressed', '" + name + "');");
      setting.appendChild(button);
    }
    else if (type === 'boolint') {
      setting.setAttribute('on', on);
      setting.setAttribute('off', off);
    }
    else if (type === 'menulist') {
      let menulist = document.createElement('menulist');
      let menupopup = document.createElement('menupopup');
      for (let { value, label } of options) {
        let menuitem = document.createElement('menuitem');
        menuitem.setAttribute('value', value);
        menuitem.setAttribute('label', label);
        menupopup.appendChild(menuitem);
      }
      menulist.appendChild(menupopup);
      setting.appendChild(menulist);
    }
    else if (type === 'multiple-select') {
      let ul = document.createElementNS(HTML_NS, 'ul');
      ul.setAttribute('data-name', name);
      
      var jsonStr = branch.getComplexValue(name, Ci.nsIPrefLocalizedString).data;
      var jsonArr;
      try {
        jsonArr = JSON.parse(jsonStr);
        if (!Array.isArray(jsonArr)) {
          throw Error("The " + type + " preference type must be set to an array.");
        }
      }
      catch(err) {
        jsonArr = [];
      }

      // Todo: Load tagit files
      var tagSource = [];
      for (let { value, label } of options) {
        tagSource[value] = label;
      }
      
      $(ul).tagit('fill', jsonArr.map((obj, i) => {
          if (typeof obj === 'string') {
            return {label: obj, value: i};
          }
          return obj; // {label, value, type}
      });
      
      /*
      jsonArr.forEach((label, value) => {
        let li = document.createElementNS(HTML_NS, 'li');
        li.setAttribute('data-value', value);
        li.setAttribute('label', label);
        ul.appendChild(li);
      });
      */
      saveTags(name, ul);
      $(ul).tagit({
        // Will setting minLength=0 allow empty strings?
        tagSource: tagSource,
        allowNewTags: open,
        initialTags: value, // Can be an array of label/value objects or of strings
        triggerKeys: ['enter', 'tab'],
        sortable: true,
        caseSensitive: true,
        highlightOnExistColor: null, // Todo: Fix library to allow duplicate values (appears easy; todo: make PR)
        tagsChanged: function (tagValue /*string*/, action, /*'added'|'popped'|'moved'|'reset'*/, li /*<li> element*/) {
          saveTags(name, ul);
        }
      });
      
      setting.appendChild(ul);
    }
    else if (type === 'radio') {
      let radiogroup = document.createElement('radiogroup');
      for (let { value, label } of options) {
        let radio = document.createElement('radio');
        radio.setAttribute('value', value);
        radio.setAttribute('label', label);
        radiogroup.appendChild(radio);
      }
      setting.appendChild(radiogroup);
    }

    parent.appendChild(setting);
  }
}
exports.injectOptions = injectOptions;
