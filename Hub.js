(function (define) {
define(function (require) {
"use strict";

	var eventNames,
		beforePhase, propagatingPhase, afterPhase, canceledPhase,
		resolver, addPropertyTransforms, simpleStrategy, defaultIdentifier,
		undef;

	// TODO: make these configurable/extensible
	eventNames = {
		// collection item events. most of these come with data. devs can
		// decide to use these events for their own purposes or send
		// different data than described here, the following list outlines
		// the intended behavior.
		add: 1, // data == item added
		remove: 1, // data == item removed
		update: 1, // data == item updated
		target: 1, // data == item targeted TODO: rename this to "point"?
		// mode events
		abort: 1, // abort the current mode (no data)
		submit: 1, // finalize the current mode (no data)
		// edit event
		edit: 1, // enter edit mode (data == item to edit)
		// multi-item events
		select: 1, // select an item (data == item)
		unselect: 1, // deselect an item (data == item)
		// network-level events (not to be used by adapters)
		join: 1, // an adapter has joined (data == adapter)
		sync: 1, // adapters need to sync (data == boolean. true == provider)
		leave: 1, // an adpater has left (data == adapter)
		// batch events
		collect: 1, // start of batch mode (until abort or submit) (data = batch purpose)
		deliver: 1 // collected items (data = batch purpose with collected items array as property)
	};

	/**
	 * Signal that event has not yet been pushed onto the network.
	 * Return false to prevent the event from being pushed.
	 */
	beforePhase = {};

	/**
	 * Signal that event is currently being propagated to adapters.
	 */
	propagatingPhase = {};

	/**
	 * Signal that an event has already been pushed onto the network.
	 * Return value is ignored since the event has already propagated.
	 */
	afterPhase = {};

	/**
	 * Signal that an event was canceled and not pushed onto the network.
	 * Return value is ignored since the event has already propagated.
	 */
	canceledPhase = {};

	resolver = require('./AdapterResolver');
	addPropertyTransforms = require('./addPropertyTransforms');
	simpleStrategy = require('./network/strategy/default');
	defaultIdentifier = require('./identifier/default');

	/**
	 * @constructor
	 * @param options.strategy {strategyFunction} a strategy
	 *   Strategies determine if an event gets onto the network and then how
	 *   it's processed by the other data sources in the network.
	 *   Only one strategy can be applied to a network. However, strategies
	 *   can be composed/combined.
	 * @param [options.events] {Object} an object to receive events
	 *   from the hub's network
	 *
	 * @description
	 * The hub exposes actions that can be propagated through the network
	 * of data sources.  These actions are the same actions supported by
	 * the adapters that wrap the data sources.  Examples include: add(),
	 * remove(), update(), select(), unselect().  Each action has the same
	 * signature: `function (data, [source]) { return bool; }`  The source
	 * parameter is optional, but may be critical for proper operation of
	 * certain strategies.  Supplying a dom event from a dom node that was
	 * added to a hub (i.e. the dom node is under a NodeListAdapter's
	 * root node) will automatically be translated to the correct data item and
	 * the correct source.
	 */
	function Hub (options) {
		var adapters, eventQueue, strategy, identifier, publicApi, eventsApi;

		// TODO: Determine if we need to save Hub options and mix them into
		// options passed thru to adapters in addSource

		// all adapters in network
		adapters = [];

		// events to be processed (fifo)
		eventQueue = [];

//		callPublicEvent = callEventsApi;

		if (!options) options = {};

		strategy = options.strategy;
		if (!strategy) strategy = simpleStrategy(options.strategyOptions);

		identifier = options.identifier || defaultIdentifier;

		// create public api
		eventsApi = publicApi = {
			addSource: addSource,
			destroy: destroy,
			forEach: forEach,
			get: itemFor
		};

		// add standard events to publicApi
		addApiMethods(eventNames);

		// add events
		addApiEvents(eventNames);

		return publicApi;

		function forEach(lambda) {
			var provider = findProvider();
			return provider && provider.forEach(lambda);
		}

		function itemFor(anything) {
			var info = findItemFor(anything, adapters);
			return info && info.item;
		}

		function findProvider() {
			var a, i = adapters.length;
			while(a = adapters[--i]) {
				if(a.provide) return a;
			}
		}

		/**
		 * @memberOf Hub
		 * @param source
		 * @param options {Object}
		 * @param [options.eventNames] {Function} function that returns a
		 *   list of method names that should be considered events
		 *   If omitted, all methods, the standard event names are used.
		 * @param options.provide {Boolean} if true, initiates a 'sync' event
		 *   from this source's adapter
		 */
		function addSource (source, options) {
			var Adapter, adapter, proxy, method, eventFinder;

			if (!options) options = {};

			if (!options.identifier) options.identifier = identifier;

			// create an adapter for this source
			// if we can't find an Adapter constructor, it is assumed to be an
			// adapter already.
			// TODO: revisit this assumption?
			// TODO: how to detect whether to use 'collection' or 'object' types
			Adapter = resolver(source, 'collection');
			adapter = Adapter ? new Adapter(source, options) : source;
			if (options.bindings) {
				adapter = addPropertyTransforms(adapter, collectPropertyTransforms(options.bindings));
			}

			proxy = beget(adapter);

			// keep copy of original source so we can match it up later
			proxy.origSource = source;
			if('provide' in options) {
				proxy.provide = options.provide;
			}

			// sniff for event hooks
			eventFinder = configureEventFinder(options.eventNames);

			// override methods that require event hooks
			for (method in adapter) {
				if (typeof adapter[method] == 'function') {
					if (eventFinder(method)) {
						// store original method on proxy (to stop recursion)
						proxy[method] = callOrigAdapterMethod(adapter, adapter[method]);
						// change public api of adapter to call back into hub
						observeAdapterMethod(adapter, method, adapter[method]);
						// ensure hub has a public method of the same name
						addApiMethod(method);
						addApiEvent(method);
					}
				}
			}

			// save the proxied adapter
			adapters.push(proxy);

			processEvent(proxy, null, 'join');

			return adapter;
		}

		function callOrigAdapterMethod (adapter, orig) {
			return function () {
				return orig.apply(adapter, arguments);
			};
		}

		function queueEvent (source, data, type) {
			var queueNeedsRestart;

			// if queue length is zero, we need to start processing it again
			queueNeedsRestart = eventQueue.length == 0;

			// enqueue event
			eventQueue.push({ source: source, data: data, type: type });

			// start processing, if necessary
			if (queueNeedsRestart) processNextEvent();
		}

		function processNextEvent () {
			var event;

			// get the next event, if any
			event = eventQueue.shift();

			// if there was an event, process it soon
			if (event) {
				setTimeout(function () {
					processEvent(event.source, event.data, event.type);
				}, 0);
			}
		}

		/*
			1. call events.beforeXXX(data)
			2. call strategy on each source/dest pair w/ event XXX and data
				- cancel iteration if any strategy returns false for any pair
			3. if not canceled, call events.XXX(data)
		 */
		function processEvent (source, data, type) {
			var context, strategyApi, i, adapter;

			context = {};

			// give public api a chance to see (and possibly cancel) event
			context.canceled = false === callEventsApi(data, camelize('before', type));

			// if public api cancels, the network never sees the event at all
			if (!context.canceled) {

				context.phase = beforePhase;
				strategyApi = createStrategyApi(context);

				strategy(source, undef, data, type, strategyApi);
				i = adapters.length;

				context.phase = propagatingPhase;
				while (!context.canceled && (adapter = adapters[--i])) {
					if (source != adapter) {
						strategy(source, adapter, data, type, strategyApi);
					}
				}

				context.phase = context.canceled ? canceledPhase : afterPhase;
				strategy(source, undef, data, type, strategyApi);

			}

			if (!context.canceled) callEventsApi(data, camelize('on', type));

			processNextEvent();

			return context.canceled;
		}

		function createStrategyApi (context) {
			function isPhase (phase) { return context.phase == phase; }
			return {
				cancel: function () { context.canceled = true; },
				isCanceled: function () { return context.canceled == true; },
				handle: function () { context.handled = true; },
				isHandled: function () { return context.handled == true; },
				queueEvent: queueEvent,
				isBefore: function () { return isPhase(beforePhase); },
				isAfter: function () { return isPhase(afterPhase); },
				isAfterCanceled: function () { return isPhase(canceledPhase); },
				isPropagating: function () { return isPhase(propagatingPhase); }
			};
		}

		function observeAdapterMethod (adapter, type, origMethod) {
			return adapter[type] = function (data) {
				processEvent(adapter, data, type);
				return origMethod.call(adapter, data);
			};
		}

		function addApiMethods (eventNames) {
			for (var name in eventNames) {
				addApiMethod(name);
			}
		}

		function addApiMethod (name) {
			if (!publicApi[name]) {
				publicApi[name] = function (anything) {
					var sourceInfo;

					sourceInfo = findItemFor(anything, adapters);

					if(!sourceInfo) {
						sourceInfo = {
							item: anything,
							source: findAdapterForSource(arguments[1], adapters)
						};
					}

					return processEvent(sourceInfo.source, sourceInfo.item, name);
				};
			}
		}

		function addApiEvents (eventNames) {
			for (var name in eventNames) {
				addApiEvent(name);
			}
		}

		function addApiEvent (name) {
			var eventName = camelize('on', name);
			// add function stub to api
			if (!eventsApi[eventName]) {
				eventsApi[eventName] = function (data) {};
			}
			// add beforeXXX stub, too
			eventName = camelize('before', name);
			if (!eventsApi[eventName]) {
				eventsApi[eventName] = function (data) {};
			}
		}

		function callEventsApi (data, name) {
			try {
				return eventsApi[name](data);
			}
			catch (ex) {
				// TODO: do something with this exception
				return false;
			}
		}

		function destroy () {
			var adapter;
			while ((adapter = adapters.pop())) {
				if (typeof adapter.destroy == 'function') {
					adapter.destroy();
				}
			}
		}

	}

	// TODO: get rid of this mess
	resolver.register(require('./ArrayAdapter'), 'collection');
	resolver.register(require('./dom/NodeListAdapter'), 'collection');
	resolver.register(require('./QueryAdapter'), 'collection');
	resolver.register(require('./dom/NodeAdapter'), 'object');
	resolver.register(require('./ObjectAdapter'), 'object');

	return Hub;

	/**
	 * Signature for all network strategy functions.
	 * @param source {Object} the adapter that sourced the event
	 * @param dest {Object} the adapter receiving the event
	 * @param data {Object} any data associated with the event
	 * @param type {String} the type of event
	 * @param api {Object} helpful functions for strategies
	 * @returns {Boolean} whether event is allowed.
	 */
	function strategyFunction (source, dest, data, type, api) {}

	function configureEventFinder (option) {
		if (typeof option == 'function') return option;

		return function (name) { return eventNames.hasOwnProperty(name); };
	}

	function findItemFor (anything, adapters) {
		var item, i, adapter;

		// loop through adapters that have the getItemForEvent() method
		// to try to find out which adapter and which data item
		i = 0;
		while (!item && (adapter = adapters[i++])) {
			if (adapter.get) {
				item = adapter.get(anything);
			}
		}

//		return item && { item: item };
		return item && { item: item, source: adapter };
	}

	function findAdapterForSource (source, adapters) {
		var i, adapter, found;

		// loop through adapters and find which one was created for this source
		i = 0;
		while (!found && (adapter = adapters[i++])) {
			if (adapter.origSource == source) {
				found = adapter;
			}
		}

		return found;
	}

	function collectPropertyTransforms (bindings) {
		var name, propertyTransforms, transform;

		propertyTransforms = {};
		for (name in bindings) {
			transform = bindings[name].transform;
			if (transform) {
				propertyTransforms[name] = transform;
			}
		}

		return propertyTransforms;
	}

	function Begetter () {}
	function beget (proto) {
		var obj;
		Begetter.prototype = proto;
		obj = new Begetter();
		Begetter.prototype = undef;
		return obj;
	}

	function noop () {}

	function camelize (prefix, name) {
		return prefix + name.charAt(0).toUpperCase() + name.substr(1);
	}

});
}(
	typeof define == 'function' && define.amd
		? define
		: function (factory) { module.exports = factory(require); }
));
