/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Home Dash.
 *
 * The Initial Developer of the Original Code is The Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Edward Lee <edilee@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";
const global = this;

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// Keep a reference to various packaged images
const images = {};

// Define a global shadow to be used for various elements
const globalShadow = "3px 3px 10px rgb(0, 0, 0)";

/**
 * Remove all existing chrome of the browser window
 */
function removeChrome(window) {
  function change(obj, prop, val) {
    let orig = obj[prop];
    obj[prop] = val;
    unload(function() obj[prop] = orig, window);
  }

  // Make sure the navigation bar isn't hidden on pages like about:addons
  change(window.TabsOnTop, "enabled", false);

  // Wait a bit for the UI to flow to grab the right size
  Utils.delay(function() {
    let {gBrowser} = window;
    let style = gBrowser.style;
    change(style, "marginTop", -gBrowser.boxObject.y + "px");
    change(style, "position", "relative");
    change(style, "zIndex", "1");
  });
}

/**
 * Add a dashboard that shows up over the main browsing area
 */
function addDashboard(window) {
  let {clearInterval, clearTimeout, document, gBrowser, setInterval, setTimeout} = window;

  // Track what to do when the dashboard goes away
  function onClose(callback) {
    // Initialize the array of onClose listeners
    let callbacks = onClose.callbacks;
    if (callbacks == null)
      callbacks = onClose.callbacks = [];

    // Calling with no arguments runs all the callbacks
    if (callback == null) {
      callbacks.forEach(function(callback) callback());
      return;
    }

    // Save the callback and give it back
    callbacks.push(callback);
    return callback;
  }

  // Track what to do when the dashboard appears for a reason
  function onOpen(reasonOrCallback) {
    // Initialize the array of onOpen listeners
    let callbacks = onOpen.callbacks;
    if (callbacks == null)
      callbacks = onOpen.callbacks = [];

    // Calling with not a function is to trigger the callbacks with the reason
    if (typeof reasonOrCallback != "function") {
      callbacks.forEach(function(callback) callback(reasonOrCallback));
      return;
    }

    // Save the callback and give it back
    callbacks.push(reasonOrCallback);
    return reasonOrCallback;
  }

  function createNode(node) {
    const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    return document.createElementNS(XUL, node);
  }

  let sixthWidth = gBrowser.boxObject.width / 6;

  //// Add master stack containing all 7 layers of the dashboard

  let masterStack = createNode("stack");
  masterStack.style.overflow = "hidden";

  // Add the stack to the current tab on first load
  masterStack.move = function() {
    gBrowser.selectedBrowser.parentNode.appendChild(masterStack);
  };
  masterStack.move();
  unload(function() masterStack.parentNode.removeChild(masterStack), window);

  // Allow normal clicking when most of the dashboard is hidden
  onClose(function() {
    masterStack.style.pointerEvents = "none";
  });

  // Don't allow clicking the current tab behind the stack when open
  onOpen(function(reason) {
    masterStack.style.pointerEvents = "auto";
  });

  // Make sure we're in the right tab stack whenever the tab switches
  listen(window, gBrowser.tabContainer, "TabSelect", function() {
    // Close the dashboard if the tab previewer isn't active (for tab close)
    if (dashboard.tabPreviewer == null)
      dashboard.open = false;

    // Make sure we don't have a tab in a preview as it'll lose its dochsell
    tabPreview.reset();

    // XXX Move the stack to the current tab even though it kills docshells
    masterStack.move();
  });

  //// 1: Search preview #1

  // Create a preview-stack and add it to the master stack
  function createPreviewStack(left, right) {
    // Previews consist of the browser and a click-screen contained in a stack
    let stack = createNode("stack");
    stack.setAttribute("left", left + "");
    stack.setAttribute("right", right + "");
    masterStack.appendChild(stack);

    // Create and set some common preview listeners and attributes
    let browser = createNode("browser");
    browser.setAttribute("autocompletepopup", gBrowser.getAttribute("autocompletepopup"));
    browser.setAttribute("contextmenu", gBrowser.getAttribute("contentcontextmenu"));
    browser.setAttribute("disablehistory", "true");
    browser.setAttribute("tooltip", gBrowser.getAttribute("contenttooltip"));
    browser.setAttribute("type", "content");
    stack.appendChild(browser);

    browser.style.boxShadow = globalShadow;
    browser.style.overflow = "hidden";

    // Put a screen over the browser to accept clicks
    let screen = createNode("box");
    stack.appendChild(screen);

    screen.style.pointerEvents = "auto";

    // Keep track of callbacks to run when no longer loading a url
    let unloadCallbacks = [];

    // Run each unload callback and clear them
    function runUnload() {
      unloadCallbacks.slice().forEach(function(callback) callback());
      unloadCallbacks.length = 0;
    }

    // Provide a way to load a url into the preview
    stack.load = function(url, callback) {
      // Nothing to load, so hide
      if (url == null || url == "") {
        stack.reset();
        return;
      }

      // If we're already on the right url, just wait for it to be shown
      if (url == browser.getAttribute("src"))
        return;

      // Must be changing urls, so inform whoever needs to know
      runUnload();

      // Save this new unload callback for later
      if (typeof callback == "function")
        unloadCallbacks.push(callback);

      // Start loading the provided url
      browser.setAttribute("src", url);
      stack.lastRequestedUrl = url;

      // Wait until the page loads to show the preview
      if (stack.collapsed) {
        stack.unlisten();
        stack.listener = function() {
          stack.unlisten();
          stack.collapsed = false;

          // Remember the current url that is successfully previewed
          stack.lastLoadedUrl = url;
        };
        browser.addEventListener("DOMContentLoaded", stack.listener, false);
      }
    };

    // Persist the preview to where the user wants
    stack.persistTo = function(targetTab, url) {
      let targetBrowser = targetTab.linkedBrowser;
      targetBrowser.stop();

      // If the preview hasn't finished loading, just go there directly
      if (stack.lastLoadedUrl != url) {
        // Allow arbitrary queries (invalid urls) to be fixed
        const flags = Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP;
        targetBrowser.loadURIWithFlags(url, flags);
        return;
      }

      // Unhook our progress listener
      let selectedIndex = targetTab._tPos;
      const filter = gBrowser.mTabFilters[selectedIndex];
      let tabListener = gBrowser.mTabListeners[selectedIndex];
      targetBrowser.webProgress.removeProgressListener(filter);
      filter.removeProgressListener(tabListener);
      let tabListenerBlank = tabListener.mBlank;

      // Restore current registered open URI
      let previewURI = browser.currentURI;
      let openPage = gBrowser._placesAutocomplete;
      if (targetBrowser.registeredOpenURI) {
        openPage.unregisterOpenPage(targetBrowser.registeredOpenURI);
        delete targetBrowser.registeredOpenURI;
      }
      openPage.registerOpenPage(previewURI);
      targetBrowser.registeredOpenURI = previewURI;

      // Just take the old history to re-set after swapping
      // TODO: Add the preview as an entry (disablehistory prevents us for now)
      let history = targetBrowser.sessionHistory;

      // Swap the docshells then fix up various properties
      targetBrowser.swapDocShells(browser);
      targetBrowser.webNavigation.sessionHistory = history;
      targetBrowser.attachFormFill();
      gBrowser.setTabTitle(targetTab);
      gBrowser.updateCurrentBrowser(true);
      gBrowser.useDefaultIcon(targetTab);

      // Restore the progress listener
      tabListener = gBrowser.mTabProgressListener(targetTab, targetBrowser, tabListenerBlank);
      gBrowser.mTabListeners[selectedIndex] = tabListener;
      filter.addProgressListener(tabListener, Ci.nsIWebProgress.NOTIFY_ALL);
      targetBrowser.webProgress.addProgressListener(filter, Ci.nsIWebProgress.NOTIFY_ALL);

      // Fix some properties because the preview is different from a tab's browser
      targetBrowser.style.overflow = "auto";
    };

    // Hide and stop the preview
    stack.reset = onClose(function() {
      runUnload();
      stack.collapsed = true;
      stack.lastLoadedUrl = null;
      stack.lastRequestedUrl = null;

      // We might have a load listener if we just started a preview
      if (browser.hasAttribute("src")) {
        browser.removeAttribute("src");
        stack.unlisten();
      }

      // Stop the preview in-case it's loading, but only if we can
      if (browser.stop != null)
        browser.stop();
    });

    // Provide a way to stop listening for the preview load
    stack.unlisten = function() {
      if (stack.listener == null)
        return;

      browser.removeEventListener("DOMContentLoaded", stack.listener, false);
      stack.listener = null;
    };

    // Prevent errors from browser.js/xul when it gets unexpected title changes
    browser.addEventListener("DOMTitleChanged", function(event) {
      event.stopPropagation();
    }, true);

    // Save the preview when clicked
    screen.addEventListener("click", function() {
      dashboard.usePreview(stack, stack.lastRequestedUrl);
    }, false);

    // Indicate what clicking will do
    screen.addEventListener("mouseover", function() {
      statusLine.set("select", browser.contentDocument.title);
    }, false);

    screen.addEventListener("mouseout", function() {
      statusLine.reset();
    }, false);

    return stack;
  }

  let searchPreview1 = createPreviewStack(0, 2 * sixthWidth);

  //// 2: Search preview #2

  let searchPreview2 = createPreviewStack(3 * sixthWidth, -sixthWidth);

  // Add some helper properties and functions to search previews
  function addSearchFunctionality(searchPreview) {
    // Helper to update engine icon state when changing
    Object.defineProperty(searchPreview, "engineIcon", {
      get: function() searchPreview._engineIcon,
      set: function(val) {
        // Inform the icon to deactivate if being replaced
        if (searchPreview.engineIcon != null)
          searchPreview.engineIcon.active = false;

        // Save the engine icon to the preview
        searchPreview._engineIcon = val;

        // Inform the icon to activate
        if (searchPreview.engineIcon != null)
          searchPreview.engineIcon.active = true;
      }
    });

    // Handle search queries to show a preview
    searchPreview.search = function(query) {
      // Nothing to search or to search with, so hide
      if (query == null || query == "" || searchPreview.engineIcon == null) {
        searchPreview.reset();
        return;
      }

      // Use the search engine to get a url and show it
      searchPreview.load(searchPreview.engineIcon.getSearchUrl(query));
    };
  }

  addSearchFunctionality(searchPreview1);
  addSearchFunctionality(searchPreview2);

  //// 3: Page and tab previews

  let pagePreview = createPreviewStack(2 * sixthWidth, -sixthWidth);

  // Create a stack for tab previews that allows swapping in tabs
  let tabPreviewStack = createNode("stack");
  tabPreviewStack.setAttribute("left", 2 * sixthWidth + "");
  tabPreviewStack.setAttribute("right", -2 * sixthWidth + "");
  masterStack.appendChild(tabPreviewStack);

  // Prepare a browser to hold the docshell for the live preview
  let tabPreview = createNode("browser");
  tabPreview.setAttribute("type", "content");
  tabPreviewStack.appendChild(tabPreview);

  tabPreview.style.boxShadow = globalShadow;

  // Prevent clicks/mouse events on the tab preview
  let tabPreviewScreen = createNode("box");
  tabPreviewStack.appendChild(tabPreviewScreen);

  tabPreviewScreen.style.pointerEvents = "auto";

  // Borrow a tab's browser until the preview goes away
  tabPreview.swap = function(tab) {
    tabPreview.swappedBrowser = tab.linkedBrowser;
    tabPreview.swapDocShells(tabPreview.swappedBrowser);
    tabPreviewStack.collapsed = false;
  };

  // Hide the preview and restore docshells
  tabPreview.reset = onClose(function() {
    tabPreviewStack.collapsed = true;

    // Make sure the browser has a docshell to swap in the future
    if (tabPreview.swappedBrowser == null) {
      tabPreview.setAttribute("src", "about:blank");
      return;
    }

    // Restore the docshell to wherever it came from
    tabPreview.swapDocShells(tabPreview.swappedBrowser);
    tabPreview.swappedBrowser = null;
  });

  // Prevent errors from browser.js/xul when it gets unexpected title changes
  tabPreview.addEventListener("DOMTitleChanged", function(event) {
    event.stopPropagation();
  }, true);

  //// 4: Main dashboard

  let dashboard = createNode("stack");
  masterStack.appendChild(dashboard);

  dashboard.collapsed = true;
  dashboard.style.backgroundColor = "rgba(0, 0, 0, .3)";
  dashboard.style.pointerEvents = "none";

  // Helper to check if the dashboard is open or open with a reason
  Object.defineProperty(dashboard, "open", {
    get: function() !!dashboard.openReason,
    set: function(reason) {
      // Update the dashboard state immediately
      dashboard.openReason = reason;

      // Inform why we're opening
      if (dashboard.open)
        onOpen(reason);
      // Run all close callbacks that include hiding the dashboard
      else
        onClose();
    }
  });

  // Helper to toggle the dashboard open/close
  dashboard.toggle = function() {
    dashboard.open = !dashboard.open;
  };

  // Persist the preview to the tab the user wants
  dashboard.usePreview = function(preview, url) {
    // Open the result in a new tab and switch to it
    if (controls.newTab) {
      let newTab = gBrowser.addTab();
      preview.persistTo(newTab, url);

      // NB: Select the tab *after* persisting, so we don't close too early
      gBrowser.selectedTab = newTab;
      return;
    }

    // Save the preview to the current tab and then close
    preview.persistTo(gBrowser.selectedTab, url);
    dashboard.open = false;
  };

  // Restore focus to the browser when closing
  onClose(function() {
    dashboard.collapsed = true;
    gBrowser.selectedBrowser.focus();
  });

  // Move focus to the dashboard when opening
  onOpen(function(reason) {
    dashboard.collapsed = false;
    dashboard.focus();

    // Hide all the dashboard data if switching tabs
    if (reason == "switch") {
      history.collapsed = true;
      searchBox.collapsed = true;
      sites.collapsed = true;
      tabs.collapsed = true;

      pagePreview.reset();
      searchPreview1.reset();
      searchPreview2.reset();
      return;
    }

    // Restore visibility to various things in the dashboard
    history.collapsed = false;
    searchBox.collapsed = false;
    sites.collapsed = false;
    tabs.collapsed = false;
  });

  // Catch various existing browser commands to redirect to the dashboard
  let commandSet = document.getElementById("mainCommandSet");
  let commandWatcher = function(event) {
    // Figure out if it's a command we're stealing
    let reason = true;
    switch (event.target.id) {
      case "Browser:OpenLocation":
        reason = "location";
        break;

      case "cmd_newNavigatorTab":
        reason = "tab";
        break;

      case "Tools:Search":
        reason = "search";
        break;

      // Not something we care about, so nothing to do!
      default:
        return;
    }

    // Open the dashboard with this reason
    dashboard.open = reason;

    // Prevent the original command from triggering
    event.stopPropagation();
  };
  commandSet.addEventListener("command", commandWatcher, true);
  unload(function() {
    commandSet.removeEventListener("command", commandWatcher, true);
  }, window);

  // Add extra behavior for switching to most-recently-used tabs
  listen(window, window, "keydown", function(event) {
    switch (event.keyCode) {
      // Allow closing of the current tab when tab previews are shown
      case event.DOM_VK_BACK_SPACE:
      case event.DOM_VK_DELETE:
      case event.DOM_VK_W:
        if (dashboard.tabPreviewer == null)
          return;

        // Show the next preview while removing the current tab
        dashboard.tabPreviewer(event.shiftKey, true);
        break;

      // Provide an alternate way to select the current preview
      case event.DOM_VK_ENTER:
      case event.DOM_VK_RETURN:
      case event.DOM_VK_SPACE:
        if (dashboard.tabPreviewer == null)
          return;

        dashboard.tabPreviewer.stop(true);
        break;

      // Provide a way to cancel out of previewing tabs
      case event.DOM_VK_ESCAPE:
      case event.DOM_VK_0:
        if (dashboard.tabPreviewer == null)
          return;

        dashboard.tabPreviewer.stop(false);
        break;

      // Watch for ctrl-tab, ctrl-9, cmd-9 to catch tab switching
      case event.DOM_VK_TAB:
      case event.DOM_VK_9:
        // If neither ctrl or cmd are pressed, ignore this event
        if (!event.ctrlKey && !event.metaKey)
          return;

        // Initialize the tab previewer
        if (dashboard.tabPreviewer == null) {
          dashboard.open = "switch";

          // Figure out the order of most-recently-used tabs
          let mruTabs = organizeTabsByUsed(tabs.filter(input.value));

          // Treat the current tab as previewed even if it is filtered out
          let previewedTab = gBrowser.selectedTab;
          if (previewedTab == mruTabs[0])
            mruTabs.shift();

          // Provide a helper to switch through MRU tabs in order or backwards
          dashboard.tabPreviewer = function(backwards, removeCurrent) {
            // Remove the current preview if necessary
            tabPreview.reset();

            // Remove the actual tab that's being previewed
            if (removeCurrent)
              gBrowser.removeTab(previewedTab);

            // Pick out the more recently used (or wrap to least)
            if (backwards) {
              // Put the current preview on the front of the list
              if (!removeCurrent)
                mruTabs.unshift(previewedTab);
              previewedTab = mruTabs.pop();
            }
            // Get the lesser recently used (or wrap to most)
            else {
              // Put the current preview on the end of the list
              if (!removeCurrent)
                mruTabs.push(previewedTab);
              previewedTab = mruTabs.shift();
            }

            // Must have closed the last tab, so abort!
            if (previewedTab == null) {
              dashboard.tabPreviewer.stop();
              return;
            }

            // Don't show a preview if it's for the current tab
            if (gBrowser.selectedTab == previewedTab) {
              statusLine.set("text", "Return to the current tab");
              return;
            }

            // Indicate what letting go of the modifier will do
            statusLine.set("switch", previewedTab.getAttribute("label"));
            tabPreview.swap(previewedTab);
          };

          // Provide a way to stop showing the tab previews
          dashboard.tabPreviewer.stop = function(selectTab) {
            // Remove the added tab preview functionality and state
            unlisten();
            dashboard.tabPreviewer = null;

            // Don't close the dashboard and switch tabs if no longer switching
            if (dashboard.openReason != "switch")
              return;

            // NB: Closing the dashboard will restore/reset the tab docshell
            dashboard.open = false;

            // Switch to the previewed tab if desired
            if (selectTab)
              gBrowser.selectedTab = previewedTab;
          };

          // Listen for un-modifying keys (ctrl and cmd) to stop previewing
          let unlisten = listen(window, window, "keyup", function(event) {
            switch (event.keyCode) {
              case event.DOM_VK_CONTROL:
              case event.DOM_VK_META:
                dashboard.tabPreviewer.stop(true);
                break;
            }
          });
        }

        // Immediately show the next preview
        dashboard.tabPreviewer(event.shiftKey, false);
        break;

      // If it's not a key combo that we care about, abort
      default:
        return;
    }

    // We must have done something special, so don't do what it would have done
    event.stopPropagation();
    event.preventDefault();
  });

  // Prevent the default behavior for ctrl-tab key presses
  listen(window, window, "keypress", function(event) {
    if (event.keyCode == event.DOM_VK_TAB && event.ctrlKey)
      event.stopPropagation();
  });

  //// 4.1: Search controls

  let searchBox = createNode("vbox");
  searchBox.setAttribute("left", "30");
  searchBox.setAttribute("right", Math.ceil(4 * sixthWidth) + "");
  searchBox.setAttribute("top", "30");
  dashboard.appendChild(searchBox);

  searchBox.style.backgroundColor = "rgb(224, 224, 224)";
  searchBox.style.borderRadius = "5px";
  searchBox.style.boxShadow = globalShadow;
  searchBox.style.padding = "5px";
  searchBox.style.pointerEvents = "auto";

  let input = createNode("textbox");
  input.setAttribute("left", "30");
  input.setAttribute("timeout", "1");
  input.setAttribute("top", "30");
  input.setAttribute("type", "search");
  searchBox.appendChild(input);

  // Take the current query to update the adaptive learning
  input.adapt = function(pageInfo) {
    updateAdaptive(input.lastQuery, pageInfo);
  };

  // Provide a helper to get the next icon that will activate on command
  Object.defineProperty(input, "nextEngineIcon", {
    get: function() {
      // If the default isn't active yet, use that right away
      if (searchPreview2.engineIcon != input.defaultEngineIcon)
        return input.defaultEngineIcon;

      // Figure out what position the next icon should be
      let engineIcons = Array.slice(engines.childNodes);
      let nextPos = engineIcons.indexOf(searchPreview1.engineIcon) + 1;

      // Use the icon only if it's not the default one
      let nextEngineIcon = engineIcons[nextPos];
      if (nextEngineIcon != input.defaultEngineIcon)
        return nextEngineIcon;

      // Move to one after the default engine if necessary
      return nextEngineIcon.nextSibling;
    }
  });

  // Maybe complete the rest of the word
  input.maybeSuggest = function() {
    // If the new query fits in the last query (deleting), don't suggest
    let query = input.value;
    if (input.lastRawQuery.indexOf(query) == 0)
      return;
    input.lastRawQuery = query;

    // No need to update if there's no new keyword
    let keyword = getKeyword(query);
    if (keyword == null || keyword == query)
      return;

    // Put in the suggestion and highlight the completed part
    input.value = keyword;
    input.setSelectionRange(query.length, keyword.length);
  };

  // Allow toggling a search engine (up to two visible at a time)
  input.toggleEngine = function(engineIcon) {
    // Set the new engine for the preview and what preview to use next
    function replaceEngine(preview, newEngineIcon, nextPreview) {
      preview.engineIcon = newEngineIcon;
      input.nextPreview = nextPreview;

      // Remove the preview if we deactivated
      if (newEngineIcon == null)
        preview.reset();
      // Start previewing immediately with the current search
      else
        preview.search(input.value);
    }

    // Deactivate the engine if it's already active
    if (searchPreview1.engineIcon == engineIcon)
      replaceEngine(searchPreview1, null, 1);
    else if (searchPreview2.engineIcon == engineIcon)
      replaceEngine(searchPreview2, null, 2);
    // Activate the engine in the next preview slot
    else if (input.nextPreview == 1)
      replaceEngine(searchPreview1, engineIcon, 2);
    else
      replaceEngine(searchPreview2, engineIcon, 1);

    // For side-by-side searches, hide all other information and resize
    if (searchPreview1.engineIcon != null) {
      history.collapsed = true;
      sites.collapsed = true;
      tabs.collapsed = true;

      searchPreview2.setAttribute("left", sixthWidth * 3 + "");
    }
    else {
      history.collapsed = false;
      sites.collapsed = false;
      tabs.collapsed = false;

      searchPreview2.setAttribute("left", sixthWidth * 2 + "");
    }

    // If both searches aren't being used, make sure the next one is "right"
    if (searchPreview1.engineIcon == null && searchPreview2.engineIcon == null)
      input.nextPreview = 2;
  };

  // Check if either previews will be searching
  Object.defineProperty(input, "willSearch", {
    get: function() {
      return (searchPreview1.engineIcon || searchPreview2.engineIcon) != null;
    }
  });

  // Clear out current state when closing
  onClose(function() {
    input.firstEmptyOpen = true;
    input.lastQuery = null;
    input.lastRawQuery = "";
    input.nextPreview = 2;
    input.value = "";
    searchPreview1.engineIcon = null;
    searchPreview2.engineIcon = null;
  });

  // Figure out if the input should be used for this opening
  onOpen(function(reason) {
    switch (reason) {
      // Clear out any searches if changing locations
      case "location":
        if (searchPreview1.engineIcon != null)
          input.toggleEngine(searchPreview1.engineIcon);
        if (searchPreview2.engineIcon != null)
          input.toggleEngine(searchPreview2.engineIcon);

        // For power users, allow getting the current tab's location when empty
        if (input.value == "") {
          // Ignore the very first opening
          if (input.firstEmptyOpen)
            input.firstEmptyOpen = false;
          else
            input.value = gBrowser.selectedBrowser.currentURI.spec;
        }

        break;

      // Automatically toggle the default engine if we need to search
      case "search":
        let nextEngineIcon = input.nextEngineIcon;

        // Deactivate the "left" search if both are active
        let leftIcon = searchPreview1.engineIcon;
        if (leftIcon != null && searchPreview2.engineIcon != null)
          input.toggleEngine(leftIcon);

        // Activate the next engine unless we just deactivated
        if (nextEngineIcon != null && nextEngineIcon != leftIcon)
          input.toggleEngine(nextEngineIcon);
        break;

      // Don't do anything if we're switching tabs
      case "switch":
        return;
    }

    // Select all the text in the box to be ready to replace existing text
    if (reason == "location" || reason == "tab")
      input.setSelectionRange(0, input.value.length);

    // Focus the input box when opening and search with anything there
    input.focus();
    input.doCommand();
  });

  // Handle the user searching for stuff
  input.addEventListener("command", function() {
    // Only suggest if the user started typing and not searching
    if (input.value != "" && !input.willSearch)
      input.maybeSuggest();

    // Skip searches that don't change usefully
    let query = input.value.trim();
    if (query == input.lastQuery)
      return;
    input.lastQuery = query;

    // Prevent accidental mouseover for things already under the pointer
    mouseSink.capture();

    // Update search previews if necessary
    if (searchPreview1.engineIcon != null)
      searchPreview1.search(query);
    if (searchPreview2.engineIcon != null)
      searchPreview2.search(query);

    // Filter out the sites display as well as get the top sites
    let topMatch = sites.search(query)[0];

    // Use the adaptive result over top site match
    topMatch = getAdaptiveInfo(query) || topMatch;

    // Do a full history search with a suggested top site
    history.search(query, topMatch);

    // Only show the tabs that match
    tabs.search(query);
  }, false);

  // Close the dashboard when hitting escape from an empty input box
  input.addEventListener("keydown", function(event) {
    if (event.keyCode == event.DOM_VK_ESCAPE && input.value == "")
      dashboard.open = false;
  }, false);

  // Look for enter after "command" has fired
  input.addEventListener("keyup", function(event) {
    // Only care about enter and return
    switch (event.keyCode) {
      case event.DOM_VK_ENTER:
      case event.DOM_VK_RETURN:
        break;

      default:
        return;
    }

    // Figure out which preview to use and url to load
    let preview, url;

    // Prefer the "left" search engine as it isn't on by default
    if (searchPreview1.engineIcon != null) {
      url = searchPreview1.engineIcon.getSearchUrl(input.lastQuery);
      preview = searchPreview1;
    }
    // Fall back to the default search if searches are active
    else if (searchPreview2.engineIcon != null) {
      url = searchPreview2.engineIcon.getSearchUrl(input.lastQuery);
      preview = searchPreview2;
    }
    // Use the top match for the query if it exists
    else if (history.topMatchBox != null) {
      url = history.topMatchBox.pageInfo.url;
      preview = pagePreview;
    }
    // Just navigate to whatever the user typed in
    else {
      url = input.lastQuery;
      preview = pagePreview;
    }

    dashboard.usePreview(preview, url);
  }, false);

  // Describe the input box
  input.addEventListener("mouseover", function() {
    statusLine.set("text", "Search your top sites, open tabs, history, and the web");
  }, false);

  input.addEventListener("mouseout", function() {
    statusLine.reset();
  }, false);

  //// 4.1.1 Search engine controls

  let engines = createNode("hbox");
  searchBox.appendChild(engines);

  engines.style.marginTop = "3px";
  engines.style.overflow = "hidden";

  // Add an icon for each search engine
  Services.search.getVisibleEngines().forEach(function(engine) {
    let engineIcon = createNode("box");
    engines.appendChild(engineIcon);

    // Style the search engine icon
    engineIcon.style.backgroundColor = "rgba(0, 0, 0, .3)";
    engineIcon.style.backgroundImage = "url(" + engine.iconURI.spec + ")";
    engineIcon.style.backgroundPosition = "center center";
    engineIcon.style.backgroundRepeat = "no-repeat";
    engineIcon.style.backgroundSize = "16px 16px";
    engineIcon.style.borderRadius = "5px";
    engineIcon.style.height = "22px";
    engineIcon.style.margin = "2px";
    engineIcon.style.width = "22px";

    // Save this engine icon if it's the one the user current uses
    if (engine == Services.search.currentEngine)
      input.defaultEngineIcon = engineIcon;

    // Provide a way to update the activeness and look of the engine
    Object.defineProperty(engineIcon, "active", {
      get: function() !!engineIcon._active,
      set: function(val) {
        engineIcon._active = val;
        engineIcon.updateLook();
      }
    });

    // Helper to get a url from a search engine
    engineIcon.getSearchUrl = function(query) {
      return engine.getSubmission(query).uri.spec;
    };

    // Provide a shared way to get the right look
    engineIcon.updateLook = function() {
      engineIcon.style.opacity = engineIcon.active ? "1" : ".6";
    };

    // Make sure each engine icon is deactivated initially
    onClose(function() {
      engineIcon.active = false;
    });

    // Inform the input to change engines
    engineIcon.addEventListener("click", function() {
      input.toggleEngine(engineIcon);
    }, false);

    // Indicate what clicking will do
    engineIcon.addEventListener("mouseover", function() {
      engineIcon.style.opacity = ".8";

      let action = engineIcon.active ? "deactivate" : "activate";
      let text = engine.name;

      // Add in some extra text for some icons
      let extras = [];
      let nextEngineIcon = input.nextEngineIcon;

      // Next engine to be activated in order
      if (engineIcon == nextEngineIcon)
        extras.push("\u2318K");

      // Default engine gets special text
      if (engineIcon == input.defaultEngineIcon)
        extras.push("default");
      // No next engine, so this secondary engine will be deactivated
      else if (nextEngineIcon == null && engineIcon.active)
        extras.push("\u2318K");

      // Put the extra text at the end if we have modifiers
      if (extras.length > 0)
        text += " (" + extras.join(", ") + ")";

      statusLine.set(action, text);
    }, false);

    engineIcon.addEventListener("mouseout", function() {
      engineIcon.updateLook();
      statusLine.reset();
    }, false);
  });

  //// 4.2: History results

  let history = createNode("vbox");
  history.setAttribute("left", "30");
  history.setAttribute("right", Math.ceil(4 * sixthWidth) + "");
  history.setAttribute("top", "150");
  dashboard.appendChild(history);

  history.style.backgroundColor = "rgb(224, 224, 224)";
  history.style.boxShadow = globalShadow;

  // Add a single page info to the list of history results
  history.add = function(pageInfo) {
    // Don't allow duplicate results with the same url
    let existingResult = history.resultMap[pageInfo.url];
    if (existingResult != null)
      return existingResult;

    let entryBox = createNode("hbox");
    entryBox.setAttribute("align", "center");
    history.appendChild(entryBox);
    history.resultMap[pageInfo.url] = entryBox;

    entryBox.pageInfo = pageInfo;

    entryBox.style.backgroundColor = "rgb(244, 244, 244)";
    entryBox.style.fontSize = "16px";
    entryBox.style.pointerEvents = "auto";

    let iconNode = createNode("image");
    iconNode.setAttribute("src", pageInfo.icon);
    entryBox.appendChild(iconNode);

    iconNode.style.height = "16px";
    iconNode.style.marginLeft = "2px";
    iconNode.style.width = "16px";

    let titleNode = createNode("label");
    titleNode.setAttribute("crop", "end");
    titleNode.setAttribute("flex", "1");
    titleNode.setAttribute("value", pageInfo.title);
    entryBox.appendChild(titleNode);

    // Save the page preview when clicked
    entryBox.addEventListener("click", function() {
      input.adapt(pageInfo);
      dashboard.usePreview(pagePreview, pageInfo.url);
    }, false);

    // Indicate what clicking will do
    entryBox.addEventListener("mouseover", function() {
      entryBox.style.textDecoration = "underline";

      // Show the preview and hide other things covering it
      pagePreview.load(pageInfo.url);
      sites.collapsed = true;
      statusLine.set("select", pageInfo.title);
      tabs.collapsed = true;
    }, false);

    entryBox.addEventListener("mouseout", function() {
      entryBox.style.textDecoration = "";

      sites.collapsed = false;
      statusLine.reset();
      pagePreview.reset();
      tabs.collapsed = false;
    }, false);

    return entryBox;
  };

  // Specially handle adding the single top match result
  history.addTopMatch = function(pageInfo) {
    // Remove styling of any previous top match
    if (history.topMatchBox != null) {
      history.topMatchBox.style.boxShadow = "";
      history.topMatchBox.style.fontSize = "16px";
      history.topMatchBox.style.fontWeight = "";
      history.topMatchBox.style.margin = "0";

      // Clear out the preview if we're about to switch urls
      if (pageInfo != null && pageInfo.url != history.topMatchBox.pageInfo.url)
        pagePreview.reset();
    }

    // Nothing else to do if there's no page to add
    if (pageInfo == null) {
      history.topMatchBox = null;
      pagePreview.reset();
      return;
    }

    // Add the top match and remember it for later
    let entryBox = history.topMatchBox = history.add(pageInfo);

    // Specially style the top match
    entryBox.style.boxShadow = globalShadow;
    entryBox.style.fontSize = "20px";
    entryBox.style.fontWeight = "bold";
    entryBox.style.margin = "0 -10px 5px -5px";

    // Start previewing this top match if not doing web searches
    if (!input.willSearch) {
      // Load the preview and clean up styles when removed
      pagePreview.load(pageInfo.url, function() {
        entryBox.style.textDecoration = "";
      });

      // Indicate that we're loading
      entryBox.style.textDecoration = "underline";
    }

    return entryBox;
  };

  // Chunk on number of rows processed as it always increases unlike frecency
  const PAGES_PER_CHUNK = 750;

  // Get all pages by frecency
  history.allPagesByFrecency = Svc.History.DBConnection.createAsyncStatement(
    "SELECT title, url " +
    "FROM moz_places " +
    "ORDER BY frecency DESC " +
    "LIMIT :offset, " + PAGES_PER_CHUNK);

  // Allow canceling an active search
  history.cancelSearch = function() {
    if (history.activeSearch == null)
      return;
    history.activeSearch.cancel();
    history.activeSearch = null;
  };

  // Clear out any state like results and active queries
  history.reset = onClose(function() {
    history.lastOffset = 0;
    history.lastQuery = null;
    history.topMatchBox = null;

    // Stop any active searches or previews if any
    history.cancelSearch();
    pagePreview.reset();

    // Remove all results and their mappings
    let node;
    while ((node = history.lastChild) != null)
      history.removeChild(node);
    history.resultMap = {};
  });

  // Search through history and add items
  history.search = function(query, topMatch) {
    // Filter existing results and continue if entering a longer search
    if (query.indexOf(history.lastQuery) == 0) {
      // Make a copy before iterating as we're removing unwanted entries
      Array.slice(history.childNodes).forEach(function(entryBox) {
        if (!queryMatchesPage(query, entryBox.pageInfo)) {
          delete history.resultMap[entryBox.pageInfo.url];
          history.removeChild(entryBox);
        }
      });

      // Make sure the top match exists and is first
      let entryBox = history.addTopMatch(topMatch);
      if (entryBox != null)
        history.insertBefore(entryBox, history.firstChild);

      // Update the query for active and new searches
      history.lastQuery = query;

      // Nothing left to do as the active search will pick up the query
      if (history.activeSearch != null)
        return;

      // Nothing left to do with all pages processed
      if (history.lastOffset == Infinity)
        return;
    }
    // Query is different enough, so start fresh
    else {
      // Stop active search and remove all results
      history.reset();

      // Don't show any results if it's just the empty search
      if (query == "")
        return;

      // Add the top match if we have one
      history.addTopMatch(topMatch);

      // Initialize the some data to process places results
      history.lastOffset = 0;
      history.lastQuery = query;
    }

    // Search through all of places starting/continuing from the offset
    history.searchPlaces(history.lastOffset);
  }

  // Search through all of places by frecency from some offset
  history.searchPlaces = function(offset) {
    let statement = history.allPagesByFrecency;
    statement.params.offset = offset;

    // Filter out history results based on the current query
    let thisSearch = history.activeSearch = statement.executeAsync({
      handleCompletion: function(reason) {
        // Only update state if it's still the active search
        if (thisSearch != history.activeSearch)
          return;

        // Remember that we finished completely
        if (history.lastOffset - offset < PAGES_PER_CHUNK) {
          history.activeSearch = null;
          history.lastOffset = Infinity;
        }
        // We got exactly the number of pages per chunk, so continue later!
        else {
          setTimeout(function() {
            // Only continue if the active search is still this one
            if (thisSearch != history.activeSearch)
              return;

            // Recursively call with the new offset
            history.searchPlaces(history.lastOffset);
          }, 50);
        }
      },

      handleError: function(error) {
        // Only update state if it's still the active search
        if (thisSearch != history.activeSearch)
          return;

        // Just remember that this search is done
        history.activeSearch = null;
      },

      handleResult: function(results) {
        // NB: Use the most recent query in-case it changes since starting
        let query = history.lastQuery;
        let numProcessed = 0;

        let row;
        while ((row = results.getNextRow()) != null) {
          // Keep track of how many rows we see to know where to continue
          numProcessed++;

          // Construct a page info to test and potentially add
          let pageInfo = {
            title: row.getResultByName("title") || "",
            url: row.getResultByName("url")
          };

          // Determine if we should show add the result
          if (!queryMatchesPage(query, pageInfo))
            continue;

          // Fill in some more page info values now that we want it
          let URI = Services.io.newURI(pageInfo.url, null, null);
          if (pageInfo.title == "")
            pageInfo.title = getHostText(URI);
          pageInfo.icon = Svc.Favicon.getFaviconImageForPage(URI).spec;
          history.add(pageInfo);

          // Stop processing current and future results if we have enough
          if (history.childNodes.length > 30) {
            history.cancelSearch();
            break;
          }
        }

        // Update the offset with however many rows got processed
        history.lastOffset += numProcessed;
      }
    });
  };

  //// 4.3: Top sites

  let sites = createNode("stack");
  sites.setAttribute("left", "850");
  sites.setAttribute("top", "450");
  dashboard.appendChild(sites);

  // Define the positions and size of the top sites
  const sizeScale = 60;
  const siteSizes = [
    [-2, -2, 2],
    [ 2, -2, 2],
    [-2,  2, 2],
    [ 2,  2, 2],
    [-5, -5, 1],
    [-3, -5, 1],
    [-1, -5, 1],
    [ 1, -5, 1],
    [ 3, -5, 1],
    [ 5, -5, 1],
    [-5, -3, 1],
    [ 5, -3, 1],
    [-5, -1, 1],
    [ 5, -1, 1],
    [-5,  1, 1],
    [ 5,  1, 1],
    [-5,  3, 1],
    [ 5,  3, 1],
    [-5,  5, 1],
    [-3,  5, 1],
    [-1,  5, 1],
    [ 1,  5, 1],
    [ 3,  5, 1],
    [ 5,  5, 1]
  ];

  // Place the top sites in-order at pre-defined locations/sizes
  topSites.forEach(function(pageInfo, index) {
    // Can't show the site if we don't know where to put it
    if (index >= siteSizes.length)
      return;

    let [leftBase, topBase, size] = siteSizes[index];

    let width = sizeScale * size * 2;
    let height = sizeScale * size * 3 / 4 * 2;
    let left = 1.1 * sizeScale * leftBase - width / 2;
    let top = 1.1 * sizeScale * topBase * 3 / 4 - height / 2;

    let siteBox = createNode("box");
    siteBox.setAttribute("left", left + "");
    siteBox.setAttribute("top", top + "");
    sites.appendChild(siteBox);

    siteBox.style.backgroundColor = "rgb(244, 244, 244)";
    siteBox.style.borderRadius = "10px";
    siteBox.style.boxShadow = globalShadow;
    siteBox.style.overflow = "hidden";

    let siteThumb = createNode("image");
    siteThumb.setAttribute("src", pageInfo.icon);
    siteBox.appendChild(siteThumb);

    siteThumb.style.height = height + "px";
    siteThumb.style.width = width + "px";

    siteBox.pageInfo = pageInfo;

    // Save the page preview when clicked
    siteBox.addEventListener("click", function() {
      input.adapt(pageInfo);
      dashboard.usePreview(pagePreview, pageInfo.url);
    }, false);

    // Indicate what clicking will do
    siteBox.addEventListener("mouseover", function() {
      pagePreview.load(pageInfo.url);
      statusLine.set("select", pageInfo.title);
      tabs.collapsed = true;

      // Emphasize this one site and dim others
      sites.highlight(siteBox);
    }, false);

    siteBox.addEventListener("mouseout", function() {
      pagePreview.reset();
      statusLine.reset();
      tabs.collapsed = false;

      // Revert to the highlighting behavior of the last query
      sites.search(sites.lastQuery);
    }, false);
  });

  // Highlight just one site box
  sites.highlight = function(targetBox) {
    // Fade out all the other boxes except the target made brighter
    Array.forEach(sites.childNodes, function(siteBox) {
      siteBox.style.opacity = siteBox == targetBox ? "1" : "0";
    });
  };

  // Search through the top sites to filter out non-matches
  sites.search = function(query) {
    // Remember what query to re-search when un-highlighting
    sites.lastQuery = query;

    // Find out which pages match the query
    let pageMatches = [];
    Array.forEach(sites.childNodes, function(siteBox) {
      // Just show the site if there's no query
      if (query == "") {
        siteBox.style.opacity = "1";
        siteBox.style.pointerEvents = "auto";
      }
      // Emphasize the match and record it
      else if (queryMatchesPage(query, siteBox.pageInfo)) {
        siteBox.style.opacity = "1";
        siteBox.style.pointerEvents = "auto";
        pageMatches.push(siteBox.pageInfo);
      }
      // Almost hide the site if not a match
      else {
        siteBox.style.opacity = "0";
        siteBox.style.pointerEvents = "none";
      }
    });
    return pageMatches;
  };

  // Revert to default styling for the next opening
  onClose(function() {
    sites.search("");
  });

  //// 4.4: Tabs

  let tabs = createNode("hbox");
  tabs.setAttribute("left", 2 * sixthWidth + 10 + "");
  tabs.setAttribute("right", "10");
  tabs.setAttribute("top", "30");
  dashboard.appendChild(tabs);

  tabs.style.backgroundColor = "rgb(224, 224, 224)";
  tabs.style.borderRadius = "5px";
  tabs.style.boxShadow = globalShadow;
  tabs.style.overflow = "hidden";
  tabs.style.pointerEvents = "auto";

  // Keep track of what count to pass down to new tabs
  tabs.lastSelectCount = 1;
  tabs.lastSelectTime = gBrowser.selectedTab.HDlastSelect = Date.now();

  // Initialize various special state to something useful
  Array.forEach(gBrowser.tabs, function(tab) {
    tab.HDselectCount = 1;
  });

  // Get an array of tabs that match a query
  tabs.filter = function(query) {
    return gBrowser.visibleTabs.filter(function(tab) {
      // Allow exact url matches to succeed without checking others
      if (tab.linkedBrowser.currentURI.spec == query)
        return true;

      // For other queries, do the same filtering as other page matches
      return queryMatchesPage(query, {
        title: tab.getAttribute("label"),
        url: tab.linkedBrowser.currentURI.spec
      });
    });
  };

  // Put app tabs first then most often selected sub sorted by most recently
  tabs.prioritize = function(a, b) {
    // Pinned tabs have priority over not-pinned but not each other
    let pinA = a.hasAttribute("pinned");
    let pinB = b.hasAttribute("pinned");
    if (pinA && !pinB)
      return -1;
    if (pinA && pinB)
      return 0;
    if (pinB && !pinA)
      return 1;

    // For regular tabs, order by most frequently selected first
    let countDiff = b.HDselectCount - a.HDselectCount;
    if (countDiff != 0)
      return countDiff;

    // For ties on selection count, break with more recently selected
    return (b.HDlastSelect || 0) - (a.HDlastSelect || 0);
  };

  // Find the open tabs that match
  tabs.search = function(query) {
    // Remove any existing search results and restore docshell if necessary
    tabs.reset();
    tabPreview.reset();

    // Figure out what the next tab to switch to will be
    let filteredTabs = tabs.filter(query);
    let nextMRUTab = organizeTabsByUsed(filteredTabs)[1];

    // Track some state to determine when to separate tabs
    let firstNormal = true;
    let firstTab = true;

    // Track various priorities to potentially assign to tabs
    let highPriority, lowPriority;

    // Keep state of moving a tab around
    let moving = false;

    // Organize the tabs that match the query then add each one
    filteredTabs.sort(tabs.prioritize).forEach(function(tab) {
      // Put in a larger spacer between app-tabs and normal ones
      let flex = 3;
      if (!tab.pinned && firstNormal) {
        firstNormal = false;
        flex = 5;
      }

      // Unless it's the first tab, then put in a smaller spacer
      if (firstTab) {
        firstTab = false;
        flex = 1;
      }

      // Only track high priorities from non-app tabs
      if (!tab.pinned && highPriority == null)
        highPriority = tab.HDselectCount;

      // Always update the low priority so it eventually gets the lowest
      lowPriority = tab.HDselectCount;

      // Insert a spacer before each tab
      let spacer = createNode("spacer");
      spacer.setAttribute("flex", flex + "");
      tabs.appendChild(spacer);

      let tabBox = createNode("stack");
      tabs.appendChild(tabBox);

      tabBox.style.backgroundColor = "rgb(244, 244, 244)";
      tabBox.style.border = "1px solid rgb(0, 0, 0)";
      tabBox.style.borderRadius = "10px";
      tabBox.style.cursor = "pointer";
      tabBox.style.position = "relative";
      tabBox.style.overflow = "hidden";
      tabBox.style.margin = "10px -122px 10px 0";

      let tabThumb = createNode("image");
      tabThumb.setAttribute("src", getTabIcon(tab));
      tabThumb.style.height = "90px";
      tabThumb.style.width = "120px";
      tabBox.appendChild(tabThumb);

      let quickNum = createNode("label");
      quickNum.setAttribute("bottom", "0");
      quickNum.setAttribute("left", "0");
      tabBox.appendChild(quickNum);

      quickNum.style.backgroundColor = "rgb(244, 244, 244)";
      quickNum.style.border = "1px solid rgb(0, 0, 0)";
      quickNum.style.borderTopRightRadius = "10px";
      quickNum.style.fontSize = "16px";
      quickNum.style.margin = "-2px";
      quickNum.style.paddingLeft = "5px";
      quickNum.style.pointerEvents = "none";
      quickNum.style.width = "20px";

      // Specially indicate that this pinned tab can be switched to
      if (tab.pinned && tab._tPos < 8)
        quickNum.value = tab._tPos + 1 + "";
      // Indicate that switching to the "last" tab is possible for this tab
      else if (tab == nextMRUTab)
        quickNum.value = "9";

      // Switch to the selected tab
      tabBox.addEventListener("click", function() {
        // Don't handle clicks if we're moving a tab
        if (moving)
          return;

        // NB: Closing the dashboard has the tab preview restoring the docshell
        dashboard.open = false;
        gBrowser.selectedTab = tab;
      }, false);

      // Prepare for moving if the user drags after clicking
      tabBox.addEventListener("mousedown", function(event) {
        // Capture mouse events on the dashboard to detect mouse drags anywhere
        dashboard.style.pointerEvents = "auto";
        tabBox.style.cursor = "move";

        // Update the non-local shared tab moving state
        moving = true;

        // Initialize some state for this potential drag
        let doneAction;
        let downPos = event.pageX;
        let origMargin = parseInt(tabBox.style.marginRight);
        let startOffset = tabBox.boxObject.screenX;

        // Track mouse movement to figure out which way the tab should move
        let stopMove = listen(window, dashboard, "mousemove", function(event) {
          let action;

          // Prioritize the tab if dragged left enough
          let offset = event.pageX - downPos;
          if (offset < -50) {
            action = "moveup";

            // Force the tab to be close to the left side of the tabs area
            offset = tabs.firstChild.boxObject.screenX - startOffset + 5;

            // If already pinned, make sure it'll be the first tab
            if (tab.pinned)
              doneAction = function() gBrowser.moveTabTo(tab, 0);
            // Otherwise just make it the last pinned tab
            else
              doneAction = function() gBrowser.pinTab(tab);
          }
          // Deprioritize the tab if dragged right enough
          else if (offset > 50) {
            action = "movedown";

            // Force the tab to be close to the right side of the tabs area
            offset = tabs.lastChild.boxObject.screenX +
                     tabs.lastChild.boxObject.width - startOffset - 148 - 5;

            // If currently pinned, unpin it and give it the highest priority
            if (tab.pinned) {
              doneAction = function() {
                gBrowser.unpinTab(tab);
                tab.HDselectCount = highPriority * 1.01;
              };
            }
            // Otherwise, give the tab the least priority
            else
              doneAction = function() tab.HDselectCount = lowPriority * .99;
          }

          // If nothing will happen to the tab, clear the status and do nothing
          if (action == null) {
            statusLine.reset();
            doneAction = function() {};
          }
          // Indicate what unclicking will do to the tab
          else
            statusLine.set(action, tab.getAttribute("label"));

          // Make the tab sit above other tabs and update its position
          tabBox.style.zIndex = "1";
          tabBox.style.marginLeft = offset + "px";
          tabBox.style.marginRight = origMargin - offset + "px";
        });

        // Detect when the user stopped dragging to clean up
        let stopUp = listen(window, dashboard, "mouseup", function() {
          // Stop capturing the mouse events and various listeners
          dashboard.style.pointerEvents = "none";
          moving = false;
          stopMove();
          stopUp();

          // Can only do an action (even if nothing) if dragged even a little
          if (doneAction == null)
            return;

          // Do the action and update the display with a fresh search
          doneAction();
          tabs.search(query);
        });
      }, false);

      // Indicate what clicking will do
      tabBox.addEventListener("mouseover", function() {
        // Don't focus this tab if we're still moving
        if (moving) {
          // Fix up the cursor to better indicate we're still dragging
          tabBox.style.cursor = "move";
          return;
        }

        tabBox.style.boxShadow = globalShadow;
        tabBox.style.marginBottom = "0";
        tabBox.style.marginTop = "0";
        tabThumb.style.height = "110px";
        tabThumb.style.width = "146px";

        // Show the tab preview and get rid of other things covering
        sites.collapsed = true;

        // Don't show a preview of the current tab
        if (gBrowser.selectedTab == tab) {
          statusLine.set("text", "Return to the current tab");
          return;
        }

        // Indicate what tab is being switched to with shortcut if available
        let text = tab.getAttribute("label");
        if (quickNum.value != "")
          text += " (\u2318" + quickNum.value + ")";
        statusLine.set("switch", text);

        tabPreview.swap(tab);
      }, false);

      tabBox.addEventListener("mouseout", function() {
        // Don't restyle if we're still moving
        if (moving)
          return;

        tabBox.style.boxShadow = "";
        tabBox.style.marginBottom = "10px";
        tabBox.style.marginTop = "10px";
        tabThumb.style.height = "90px";
        tabThumb.style.width = "120px";

        sites.collapsed = false;

        statusLine.reset();
        tabPreview.reset();
      }, false);
    });

    // Fix up the right margin of the last tab and insert a spacer
    let lastTab = tabs.lastChild;
    if (lastTab != null) {
      lastTab.style.marginRight = "0";

      let spacer = createNode("spacer");
      spacer.setAttribute("flex", "1");
      tabs.appendChild(spacer);
    }

    // If we don't have a high priority for some reason, just take the low
    if (highPriority == null)
      highPriority = lowPriority;
  };

  // Clean up any tabs from a search when closing
  tabs.reset = onClose(function() {
    let node;
    while ((node = tabs.lastChild) != null)
      tabs.removeChild(node);
  });

  // Newly opened tabs inherit some properties of the last selected tab
  listen(window, gBrowser.tabContainer, "TabOpen", function(event) {
    let tab = event.target;

    // Inherit the full last selection time
    tab.HDlastSelect = tabs.lastSelectTime;

    // Reduce the count by a little bit but pass down most of the value
    tabs.lastSelectCount *= .9;
    tab.HDselectCount = tabs.lastSelectCount;
  });

  // Count how many times each tab is selected
  listen(window, gBrowser.tabContainer, "TabSelect", function(event) {
    let tab = event.target;
    tab.HDlastSelect = Date.now();
    tab.HDselectCount = tab.HDselectCount + 1;

    // Remember this tab's selection count to inherit later
    tabs.lastSelectCount = tab.HDselectCount;
    tabs.lastSelectTime = tab.HDlastSelect;
  });

  // Clear out any state we set on external objects
  unload(function() {
    Array.forEach(gBrowser.tabs, function(tab) {
      tab.HDlastSelect = 0;
      tab.HDselectCount = 0;
    });
  });

  //// 4.5: Browser controls

  let controls = createNode("hbox");
  controls.setAttribute("left", "30");
  controls.setAttribute("top", "110");
  dashboard.appendChild(controls);

  controls.style.overflow = "visible";

  let newTabButton = createNode("button");
  newTabButton.setAttribute("label", "New tab");
  controls.appendChild(newTabButton);

  newTabButton.style.backgroundColor = "rgb(244, 244, 244)";
  newTabButton.style.borderRadius = "5px";
  newTabButton.style.padding = "5px";
  newTabButton.style.pointerEvents = "auto";

  // Control if pages should be opened in new tabs or not
  Object.defineProperty(controls, "newTab", {
    get: function() !!newTabButton.checked,
    set: function(val) {
      newTabButton.checked = val;
      newTabButton.updateLook();
    }
  });

  // Provide a shared way to get the right look
  newTabButton.updateLook = function() {
    if (controls.newTab) {
      newTabButton.style.opacity = "1";
    }
    else {
      newTabButton.style.opacity = ".7";
    }
  };

  // Reset and initialize various control state
  onClose(function() {
    controls.collapsed = false;
    controls.newTab = false;
  });

  // Pick the appropriate new tab state for various open reasons
  onOpen(function(reason) {
    switch (reason) {
      case "search":
        controls.newTab = true;
        break;

      case "switch":
        controls.collapsed = true;
        break;

      case "tab":
        controls.newTab = !controls.newTab;
        break;
    }
  });

  // Toggle the new-tab-ness for each click
  newTabButton.addEventListener("click", function() {
    controls.newTab = !controls.newTab;
  }, false);

  // Indicate what clicking will do
  newTabButton.addEventListener("mouseover", function() {
    newTabButton.style.opacity = ".8";

    let action = controls.newTab ? "deactivate" : "activate";
    statusLine.set(action, "selecting pages as a new tab (\u2318T)");
  }, false);

  newTabButton.addEventListener("mouseout", function() {
    newTabButton.updateLook();
    statusLine.reset();
  }, false);

  //// 5: Status line

  let statusBox = createNode("box");
  statusBox.setAttribute("left", "0");
  statusBox.setAttribute("right", "0");
  statusBox.setAttribute("top", "0");
  masterStack.appendChild(statusBox);

  statusBox.style.overflow = "hidden";
  statusBox.style.pointerEvents = "none";

  let statusLine = createNode("label");
  statusBox.appendChild(statusLine);

  statusLine.style.backgroundColor = "rgba(224, 224, 224, .8)";
  statusLine.style.borderBottomRightRadius = "10px";
  statusLine.style.fontSize = "16px";
  statusLine.style.margin = "0";
  statusLine.style.padding = "0 3px 2px 28px";

  // Helper function to set the status text for a given action
  statusLine.set = function(action, text) {
    switch (action) {
      case "activate":
        text = "Activate " + text;
        break;

      case "deactivate":
        text = "Deactivate " + text;
        break;

      case "loadpage":
        text = "View " + text;
        break;

      case "loadref":
        text = "Jump to " + text;
        break;

      case "loadsite":
        text = "Go to " + text;
        break;

      case "movedown":
        text = "Deprioritize " + text;
        break;

      case "moveup":
        text = "Prioritize " + text;
        break;

      case "reload":
        text = "Reload " + text;
        break;

      case "select":
        if (controls.newTab)
          text = "Tabify " + text;
        else
          text = "Select " + text;
        break;

      case "switch":
        text = "Switch to " + text;
        break;

      // Just use the provided text
      case "text":
        break;

      case "toggle":
        text = "Toggle " + text;
        break;

      // Hide the status for no/unknown action/text
      default:
        statusLine.reset();
        return;
    }

    statusLine.collapsed = false;
    statusLine.value = text;
  };

  // Clear out the status line when closing or resetting
  statusLine.reset = onClose(function() {
    statusLine.collapsed = true;
    statusLine.value = "";
  });

  let (orig = window.XULBrowserWindow.setOverLink) {
    window.XULBrowserWindow.setOverLink = function(url, anchor) {
      // Clear the status if there's nothing to show
      if (url == "") {
        statusLine.reset();
        return;
      }

      // Figure out what kind of action and text to show
      let action = "loadpage";
      let text = getTextContent(anchor);
      let curURI = gBrowser.selectedBrowser.currentURI;
      let newURI = Services.io.newURI(url, null, null);

      // Figure out if we're switching sites
      if (curURI.scheme != newURI.scheme || hosty(curURI) != hosty(newURI)) {
        // Specially handle certain protocols
        switch (newURI.scheme) {
          case "data":
            action = "loadsite";
            text = "data: resource";
            break;

          case "https":
            action = "loadsite";
            text = "secure " + getHostText(newURI);
            break;

          case "javascript":
            action = "text";
            text = "Run script";
            break;

          case "mailto":
            action = "text";
            text = "Email " + newURI.path.split("?")[0];
            break;

          default:
            action = "loadsite";
            text = getHostText(newURI);
            break;
        }
      }
      // Figure out if it's a reference change
      else if (curURI instanceof Ci.nsIURL && newURI instanceof Ci.nsIURL) {
        if (curURI.filePath == newURI.filePath && curURI.query == newURI.query)
          action = curURI.ref == newURI.ref ? "reload" : "loadref";
      }

      // Figure out a text for missing anchor or same domain pages
      if (text == null || text == "") {
        let path = newURI.path;

        // Find out the end of the path part before query or hash
        let end = path.indexOf("?");
        if (end == -1)
          end = path.indexOf("#");

        // Default to the end unless it's a trailing slash
        if (end == -1)
          end = path.length;
        if (path[end - 1] == "/")
          end--;

        // Get the last part after the last "/" of the path
        let lastPart = path.slice(path.lastIndexOf("/", end - 1) + 1, end);

        // Remove the file extension if necessary
        let extDot = lastPart.indexOf(".");
        if (extDot != -1)
          lastPart = lastPart.slice(0, extDot);

        // Upper-case each word of the last part
        text = upperFirst(lastPart.split(/[-_.+]+/));

        // Must be the root page path
        if (text == "")
          text = getHostText(newURI) + "'s home page";
      }

      statusLine.set(action, text);
    };
    unload(function() window.XULBrowserWindow.setOverLink = orig, window);
  }

  //// 6: Notification area

  let notifications = createNode("vbox");
  notifications.setAttribute("left", "0");
  notifications.setAttribute("top", "22");
  masterStack.appendChild(notifications);

  notifications.style.pointerEvents = "auto";

  // Provide a way to add a notification icon for a tab
  notifications.addTab = function(tab, callback) {
    // Check if we already have a notification for the tab
    let exists = Array.some(notifications.childNodes, function(icon) {
      if (icon.tab != tab)
        return false;

      // Add the callback to this tab's notification
      icon.callbacks.push(callback);
      return true;
    });
    if (exists)
      return;

    // Add an icon for the tab and track various properties
    let tabIcon = createNode("box");
    notifications.appendChild(tabIcon);
    let callbacks = tabIcon.callbacks = [];
    tabIcon.tab = tab;
    tabIcon.state = 0;

    // Use the favicon or a default page icon
    function updateIcon() {
      let src = getTabIcon(tab);
      if (src != updateIcon.lastSrc) {
        tabIcon.style.backgroundImage = "url(" + src + ")";
        updateIcon.lastSrc = src;
      }
    }
    updateIcon();

    // Style the tab notification icon
    tabIcon.style.backgroundColor = "rgba(0, 0, 0, .3)";
    tabIcon.style.backgroundPosition = "2px center";
    tabIcon.style.backgroundRepeat = "no-repeat";
    tabIcon.style.borderRadius = "0 25% 25% 0";
    tabIcon.style.height = "22px";
    tabIcon.style.width = "22px";

    // Add some callbacks to run when the tab is selected
    if (typeof callback == "function")
      callbacks.push(callback);
    callbacks.push(function() notifications.removeChild(tabIcon));

    // Run all the callbacks including removing the tab icon
    function runCallbacks() {
      callbacks.forEach(function(callback) callback());
    }

    // Run callbacks and remove notification and listeners on close or select
    callbacks.push(listen(window, tab, "TabClose", runCallbacks));
    callbacks.push(listen(window, tab, "TabSelect", runCallbacks));

    // Update the notification icon if the tab's icon changes
    callbacks.push(listen(window, tab, "TabAttrModified", updateIcon));

    // Switch to the tab when the notification icon is clicked
    tabIcon.addEventListener("click", function() {
      // Figure out where this icon sits of the visible ones
      let visibleItems = Array.filter(notifications.childNodes, function(item) {
        return !item.collapsed;
      });

      // Don't automatically load the next preview if we'll point at another
      if (visibleItems.pop() != tabIcon)
        notifications.skipPreview = true;
      else
        notifications.skipPreview = false;

      // Select the tab which will remove this notification
      gBrowser.selectedTab = tab;
    }, false);

    // Indicate what clicking will do
    tabIcon.addEventListener("mouseover", function() {
      // Only show an instant preview if it's not automatically "over"
      if (!notifications.skipPreview) {
        tabPreview.swap(tab);

        // Remove other things that might cover the preview
        if (dashboard.open) {
          sites.collapsed = true;
          tabs.collapsed = true;
        }
      }

      statusLine.set("switch", tab.getAttribute("label"));
    }, false);

    tabIcon.addEventListener("mouseout", function() {
      // We've successfully moved out of the notification, so previews are ok
      notifications.skipPreview = false;

      // Re-show things that might have covered the preview
      if (dashboard.open) {
        sites.collapsed = false;
        tabs.collapsed = false;
      }

      statusLine.reset();
      tabPreview.reset();;
    }, false);
  };

  // Provide a way to pause/unpause
  Object.defineProperty(notifications, "paused", {
    get: function() notifications._paused,
    set: function(val) {
      // Don't do work if we're already of that state
      val = !!val;
      if (val == notifications.paused)
        return;
      notifications._paused = val;

      // Nothing more to do if we're unpausing
      if (!notifications.paused)
        return;

      // Make all notifications opaque
      Array.forEach(notifications.childNodes, function(notification) {
        notification.style.opacity = "1";
      });
    }
  });
  notifications._paused = false;

  // Continue updating when closing
  onClose(function() {
    notifications.paused = false;
  });

  // Pause updating when opening
  onOpen(function(reason) {
    notifications.paused = true;

    // Re-show the notifications that have been hidden
    Array.forEach(notifications.childNodes, function(notification) {
      notification.collapsed = false;
    });
  });

  // Keep updating notification icons and remove old ones
  let notifyInt = setInterval(function() {
    // Don't update the state when paused
    if (notifications.paused)
      return;

    // Figure out opaqueness of all notifications
    Array.forEach(notifications.childNodes, function(notification) {
      // Skip notifications that aren't visible anyway
      if (notification.collapsed)
        return;

      // Update until 600 iterations (60 seconds)
      let state = ++notification.state;
      // NB: Check for >= 600 as the notification can be unhidden
      if (state >= 600)
        notification.collapsed = true;
      else {
        // Icon opacity: abs(cos(x^4)) [positive, repeating, decreasing period]
        let opacity = Math.abs(Math.cos(Math.pow(state / 250, 4)));
        // Decrease opacity to 0 as state -> 600
        opacity = Math.pow(opacity * Math.pow(1 - state / 600, .3), .2);
        notification.style.opacity = opacity;
      }
    });
  }, 100);
  unload(function() clearInterval(notifyInt), window);

  // Pause updating opacity if the user might click
  notifications.addEventListener("mouseover", function() {
    notifications.paused = true;
  }, false);

  notifications.addEventListener("mouseout", function() {
    notifications.paused = dashboard.open;
  }, false);

  // Watch for title changes in background tabs
  listen(window, gBrowser, "DOMTitleChanged", function(event) {
    // Only care about top-level title changes
    let content = event.target.defaultView;
    if (content != content.top)
      return;

    // No need to notify for fake tabs or the current tab
    let tab = gBrowser._getTabForContentWindow(content);
    if (tab == null || tab == gBrowser.selectedTab)
      return;

    // Don't notify or update the count if we already triggered
    const CHANGE_THRESHOLD = 2;
    let count = (tab.HDtitleChangedCount || 0) + 1;
    if (count > CHANGE_THRESHOLD)
      return;
    tab.HDtitleChangedCount = count;

    if (count == CHANGE_THRESHOLD)
      notifications.addTab(tab, function() tab.HDtitleChangedCount = 0);
  });

  // Don't switch to the tab on modal and show a notification instead
  listen(window, window, "DOMWillOpenModalDialog", function(event) {
    event.stopPropagation();

    // Only show notification for background tabs
    let tab = gBrowser._getTabForContentWindow(event.target.top);
    if (tab != gBrowser.selectedTab)
      notifications.addTab(tab);
  });

  // Watch for tabs being opened in the background
  listen(window, gBrowser.tabContainer, "TabOpen", function(event) {
    notifications.addTab(event.target);
  });

  // Clear out any state we set on external objects
  unload(function() {
    Array.forEach(gBrowser.tabs, function(tab) tab.HDtitleChangedCount = 0);
  });

  //// 7: Firefox icon

  let fxIcon = createNode("image");
  fxIcon.setAttribute("left", "0");
  fxIcon.setAttribute("src", images["firefox22.png"]);
  fxIcon.setAttribute("top", "0");
  masterStack.appendChild(fxIcon);

  fxIcon.style.height = "22px";
  fxIcon.style.opacity = ".3";
  fxIcon.style.pointerEvents = "auto";
  fxIcon.style.width = "22px";

  // Just go back to the default opacity when closing the dashboard
  fxIcon.reset = onClose(function() {
    fxIcon.style.opacity = dashboard.open ? "1" : ".3";
  });

  // Allow toggling the dashboard by clicking
  fxIcon.addEventListener("click", function() {
    dashboard.toggle();
  }, false);

  // Indicate what clicking will do
  fxIcon.addEventListener("mouseover", function() {
    fxIcon.style.opacity = "1";
    statusLine.set("toggle", "Home Dash");
  }, false);

  fxIcon.addEventListener("mouseout", function() {
    fxIcon.reset();
    statusLine.reset();
  }, false);

  //// 8: Mouseover event sink

  let mouseSink = createNode("box");
  masterStack.appendChild(mouseSink);

  // Capture mouse events so nodes under the mouse don't mouseover immediately
  mouseSink.capture = function() {
    // Direct mouse events to this layer
    mouseSink.style.pointerEvents = "auto";

    // Don't add another listener
    if (mouseSink.unmove != null)
      return;

    // Save a way to remove the mousemove listener
    mouseSink.unmove = listen(window, mouseSink, "mousemove", mouseSink.reset);
  };

  // Clean up the listener when stopping
  mouseSink.reset = onClose(function() {
    // Restore mouseover/mouseout events to whatever is under the pointer
    mouseSink.style.pointerEvents = "none";

    // Can't stop the listener multiple times
    if (mouseSink.unmove == null)
      return;

    // Stop listening for mousemove
    mouseSink.unmove();
    mouseSink.unmove = null;
  });

  // Pretend the dashboard just closed to initialize things
  onClose();
}

/**
 * Handle the add-on being activated on install/enable
 */
function startup({id}) AddonManager.getAddonByID(id, function(addon) {
  // XXX Force a QI until bug 609139 is fixed
  Cu.import("resource://services-sync/util.js");
  Svc.History.QueryInterface(Ci.nsPIPlacesDatabase);

  // Get references to the packaged images
  ["defaultFavicon.png", "firefox22.png"].forEach(function(fileName) {
    images[fileName] = addon.getResourceURI("images/" + fileName).spec;
  });

  // Load various javascript includes for helper functions
  ["crunch", "helper", "utils"].forEach(function(fileName) {
    let fileURI = addon.getResourceURI("scripts/" + fileName + ".js");
    Services.scriptloader.loadSubScript(fileURI.spec, global);
  });

  // Crunch through some data to use later
  computeTopSites();
  processAdaptive();

  // Change the main browser windows
  watchWindows(removeChrome);
  watchWindows(addDashboard);
})

/**
 * Handle the add-on being deactivated on uninstall/disable
 */
function shutdown(data, reason) {
  // Clean up with unloaders when we're deactivating
  if (reason != APP_SHUTDOWN)
    unload();
}

/**
 * Handle the add-on being installed
 */
function install(data, reason) {}

/**
 * Handle the add-on being uninstalled
 */
function uninstall(data, reason) {}
