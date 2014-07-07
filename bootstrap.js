// Template based on Private Tab by Infocatcher
// https://addons.mozilla.org/firefox/addon/private-tab

'use strict';

const WINDOW_LOADED = -1;
const WINDOW_CLOSED = -2;

const LOG_PREFIX = '[Memory Monitor] ';
const PREF_BRANCH = 'extensions.uaSad@MemoryMonitor.';
const ADDON_ROOT = 'chrome://uasadmemorymonitor/content/';
const PREF_FILE = ADDON_ROOT + 'defaults/preferences/prefs.js';

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import('resource://gre/modules/Services.jsm');
(function(global) {
	// firefox 32
	let consoleJSM = Cu.import('resource://gre/modules/devtools/Console.jsm', {});
	if (typeof console === 'undefined')
		global.console = consoleJSM.console;
})(this);

function install(params, reason) {
}
function uninstall(params, reason) {
	if (reason !== ADDON_UNINSTALL)
		return;

	let deletePrefsOnUninstall = PREF_BRANCH + 'deletePrefsOnUninstall';

	if (Services.prefs.getPrefType(deletePrefsOnUninstall) === 128 &&
			Services.prefs.getBoolPref(deletePrefsOnUninstall))
		Services.prefs.deleteBranch(PREF_BRANCH);
}
function startup(params, reason) {
	memoryMonitor.init(reason);
}
function shutdown(params, reason) {
	memoryMonitor.destroy(reason);
}

let memoryMonitor = {
	initialized: false,
	init: function(reason) {
		if (this.initialized)
			return;
		this.initialized = true;

		prefs.init();

		let interval = this._checkInterval(prefs.get('_interval', '2'));
		if (interval)
			mmChrome.prototype._interval = interval;
		mmChrome.prototype._prefix = prefs.get('_prefix', 'MiB');
		mmChrome.prototype._dPrefix = prefs.get('_dPrefix', true);
		let fSpacer = this._getSpacer(prefs.get('_fSpacer', ' '));
		if (fSpacer || fSpacer === '')
			mmChrome.prototype._fSpacer = fSpacer;

		for (let window in this.windows)
			this.initWindow(window, reason);
		Services.ww.registerNotification(this);
	},
	destroy: function(reason) {
		if (!this.initialized)
			return;
		this.initialized = false;

		for (let window in this.windows)
			this.destroyWindow(window, reason);
		Services.ww.unregisterNotification(this);

		prefs.destroy();
	},

	observe: function(subject, topic, data) {
		if (topic == 'domwindowopened')
			subject.addEventListener('load', this, false);
	},

	handleEvent: function(event) {
		switch (event.type) {
			case 'load':
				this.loadHandler(event);
				break;
		}
	},
	loadHandler: function(event) {
		let window = event.originalTarget.defaultView;
		window.removeEventListener('load', this, false);
		this.initWindow(window, WINDOW_LOADED);
	},


	initWindow: function(window, reason) {
		if (reason == WINDOW_LOADED && !this.isTargetWindow(window)) {
			return;
		}

		memoryMonitorMap.set(window, new mmChrome(window));
	},
	destroyWindow: function(window, reason) {
		window.removeEventListener('load', this, false); // Window can be closed before "load"
		if (reason == WINDOW_CLOSED && !this.isTargetWindow(window))
			return;

		if (reason != WINDOW_CLOSED) {
			// See resource:///modules/sessionstore/SessionStore.jsm
			// "domwindowclosed" => onClose() => "SSWindowClosing"
			// This may happens after our "domwindowclosed" notification!
			let mm = memoryMonitorMap.get(window);
			if (mm)
				mm.destroy();
		}
	},

	get windows() {
		let ws = Services.wm.getEnumerator('navigator:browser');
		while (ws.hasMoreElements()) {
			let window = ws.getNext();
			yield window;
		}
	},
	isTargetWindow: function(window) {
		// Note: we can't touch document.documentElement in not yet loaded window
		// (to check "windowtype"), see https://github.com/Infocatcher/Private_Tab/issues/61
		let loc = window.location.href;
		return loc == 'chrome://browser/content/browser.xul';
	},

	prefChanged: function(pName, pVal) {
		switch (pName) {
			case '_interval':
				{
					let interval = this._checkInterval(pVal);
					if (interval)
						this._setInterval(interval);
				}
				break;
			case '_prefix':
				{
					let prefixs = ['B', 'KB', 'KiB', 'MB', 'MiB', 'GB', 'GiB'];
					let index = -1;
					let pVal_lc = pVal.toLocaleLowerCase();
					prefixs.forEach(function(val, i) {
						if (val.toLocaleLowerCase() === pVal_lc)
							index = i;
					});
					if (index !== -1)
						mmChrome.prototype._prefix = prefixs[index];
				}
				break;
			case '_dPrefix':
				{
					mmChrome.prototype._dPrefix = pVal;
				}
				break;
			case '_fSpacer':
				{
					let fSpacer = this._getSpacer(pVal);
					if (fSpacer || fSpacer === '')
						mmChrome.prototype._fSpacer = fSpacer;
				}
				break;
		}
	},

	_getSpacer: function(pVal) {
		if (mmChrome.prototype._fSpacer === pVal)
			return false;

		let spacers = [',', '-', ' ', ''];
		let index = spacers.indexOf(pVal);
		if (index !== -1)
			return spacers[index];
	},

	_checkInterval: function(pVal) {
		// min - 0.1s (or 100ms)
		// max - 3600s (or 60m or 1h)
		let interval = parseInt(parseFloat(pVal) * 1000);
		if (interval > 99 && interval < 3600001)
			return interval;
	},

	_setInterval: function(interval) {
		if (mmChrome.prototype._interval === interval)
			return;

		mmChrome.prototype._interval = interval;

		for (let window in this.windows) {
			let mm = memoryMonitorMap.get(window);
			if (mm)
				mm._setInterval();
		}
	}
};

let memoryMonitorMap = new WeakMap();

function mmChrome(window) {
	this.interval = null;
	this.window = null;
	this.init(window);
}

mmChrome.prototype = {
	_interval: 2000, //ms
	_prefix: 'MiB', //B, KB, KiB, MB, MiB, GB, GiB
	_dPrefix: true,
	_fSpacer: ' ',

	_setInterval: function() {
		let {setInterval, clearInterval} = this.window;
		clearInterval(this.interval);

		this.interval = setInterval(this.start.bind(this), this._interval);
	},

	init: function(window) {
		this.window = window;
		let {document, setInterval} = window;
		window.addEventListener('unload', this, false);

		let memoryLabel = this.memoryLabel = document.createElement('label');
		memoryLabel.id = 'memory-monitor-uasad';
		document.getElementById('urlbar-icons').appendChild(memoryLabel);

		this.start();
		this.interval = setInterval(this.start.bind(this), this._interval);
	},
	uninit: function() {
		let {clearInterval} = this.window;
		clearInterval(this.interval);
	},
	destroy: function() {
		let {window} = this;
		let {document} = window;
		window.removeEventListener('unload', this, false);

		this.uninit();
		let mm = document.getElementById('memory-monitor-uasad');
		if (mm)
			mm.parentNode.removeChild(mm);

		memoryMonitorMap.delete(window);
	},
	handleEvent: function(event) {
		switch (event.type) {
			case 'unload':
				this.destroy();
				break;
		}
	},

	addFigure: function(str) {
		let num = String(str).replace(/\D/g, '');
		return num.replace(/(\d)(?=((\d{3})+)(\D|$))/g, '$1' + this._fSpacer);
	},

	getSize: function(mem, flag) {
		let pre = 1;
		switch (this._prefix) {
			case 'KB':
				pre = 1000;
				break;
			case 'KiB':
				pre = 1024;
				break;
			case 'MB':
				pre = 1000 * 1000;
				break;
			case 'MiB':
				pre = 1024 * 1024;
				break;
			case 'GB':
				pre = 1000 * 1000 * 1000;
				break;
			case 'GiB':
				pre = 1024 * 1024 * 1024;
				break;
		};

		mem = mem / pre;

		if (mem > 1)
			mem = Math.round(mem);
		else
			mem = mem.toFixed(3);

		if (mem > 999)
			return this.addFigure(mem);
		return String(mem);
	},

	setPrefix: function(flag) {
		return (flag) ? ' ' + this._prefix : '';
	},

	get mgr() {
		delete mmChrome.prototype.mgr;
		return mmChrome.prototype.mgr = Cc['@mozilla.org/memory-reporter-manager;1'].
			getService(Ci.nsIMemoryReporterManager);
	},

	start: function() {
		try {
			this.memoryLabel.value = this.getSize(this.mgr.residentFast || this.mgr.resident) + this.setPrefix(this._dPrefix);
		}
		catch (ex) {
			this.window.clearInterval(this.interval);
		};
	}
};

let prefs = {
	ns: PREF_BRANCH,
	version: 1,
	initialized: false,
	init: function() {
		if (this.initialized)
			return;
		this.initialized = true;

		let curVersion = this.getPref(this.ns + 'prefsVersion', 0);
		if (curVersion < this.version) {
			this.migratePrefs(curVersion);
			this.setPref(this.ns + 'prefsVersion', this.version);
		}

		//~ todo: add condition when https://bugzilla.mozilla.org/show_bug.cgi?id=564675 will be fixed
		this.loadDefaultPrefs();
		Services.prefs.addObserver(this.ns, this, false);
	},
	destroy: function() {
		if (!this.initialized)
			return;
		this.initialized = false;

		Services.prefs.removeObserver(this.ns, this);
	},
	migratePrefs: function(version) {
		let boolean = function(pName) { // true -> 1
			if (this.getPref(pName) === true) {
				Services.prefs.deleteBranch(pName);
				this.setPref(pName, 1);
			}
		}.bind(this);
	},
	observe: function(subject, topic, pName) {
		if (topic != 'nsPref:changed')
			return;
		let shortName = pName.substr(this.ns.length);
		let val = this.getPref(pName);
		this._cache[shortName] = val;
		memoryMonitor.prefChanged(shortName, val);
	},

	loadDefaultPrefs: function() {
		let defaultBranch = Services.prefs.getDefaultBranch('');
		let prefsFile = PREF_FILE;
		let prefs = this;
		let scope = {
			pref: function(pName, val) {
				let pType = defaultBranch.getPrefType(pName);
				if (pType != defaultBranch.PREF_INVALID && pType != prefs.getValueType(val)) {
					Cu.reportError(
						LOG_PREFIX + 'Changed preference type for "' + pName
						+ '", old value will be lost!'
					);
					defaultBranch.deleteBranch(pName);
				}
				prefs.setPref(pName, val, defaultBranch);
			}
		};
		Services.scriptloader.loadSubScript(prefsFile, scope);
	},

	// Using __proto__ or setPrototypeOf to set a prototype is now deprecated.
	// https://bugzilla.mozilla.org/show_bug.cgi?id=948227
	_cache: Object.create(null),
	get: function(pName, defaultVal) {
		let cache = this._cache;
		return pName in cache
			? cache[pName]
			: (cache[pName] = this.getPref(this.ns + pName, defaultVal));
	},
	set: function(pName, val) {
		return this.setPref(this.ns + pName, val);
	},
	getPref: function(pName, defaultVal, prefBranch) {
		let ps = prefBranch || Services.prefs;
		switch (ps.getPrefType(pName)) {
			case ps.PREF_BOOL:
				return ps.getBoolPref(pName);
			case ps.PREF_INT:
				return ps.getIntPref(pName);
			case ps.PREF_STRING:
				return ps.getComplexValue(pName, Ci.nsISupportsString).data;
		}
		return defaultVal;
	},
	setPref: function(pName, val, prefBranch) {
		let ps = prefBranch || Services.prefs;
		let pType = ps.getPrefType(pName);
		if (pType == ps.PREF_INVALID)
			pType = this.getValueType(val);
		switch (pType) {
			case ps.PREF_BOOL:
				ps.setBoolPref(pName, val);
				break;
			case ps.PREF_INT:
				ps.setIntPref(pName, val);
				break;
			case ps.PREF_STRING:
				let ss = Ci.nsISupportsString;
				let str = Cc['@mozilla.org/supports-string;1']
					.createInstance(ss);
				str.data = val;
				ps.setComplexValue(pName, ss, str);
		}
		return this;
	},
	getValueType: function(val) {
		switch (typeof val) {
			case 'boolean':
				return Services.prefs.PREF_BOOL;
			case 'number':
				return Services.prefs.PREF_INT;
		}
		return Services.prefs.PREF_STRING;

	},
	has: function(pName) {
		return this._has(pName);
	},
	_has: function(pName) {
		let ps = Services.prefs;
		pName = this.ns + pName;
		return (ps.getPrefType(pName) != Ci.nsIPrefBranch.PREF_INVALID);
	},
	reset: function(pName) {
		if (this.has(pName))
			this._reset(pName);
	},
	_reset: function(pName) {
		let ps = Services.prefs;
		pName = this.ns + pName;
		try {
			ps.clearUserPref(pName);
		}
		catch (ex) {
			// The pref service throws NS_ERROR_UNEXPECTED when the caller tries
			// to reset a pref that doesn't exist or is already set to its default
			// value.  This interface fails silently in those cases, so callers
			// can unconditionally reset a pref without having to check if it needs
			// resetting first or trap exceptions after the fact.  It passes through
			// other exceptions, however, so callers know about them, since we don't
			// know what other exceptions might be thrown and what they might mean.
			if (ex.result != Cr.NS_ERROR_UNEXPECTED)
				throw ex;
		}
	}
};
