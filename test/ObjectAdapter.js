(function(buster, ObjectAdapter) {
"use strict";

var assert, refute, undef;

assert = buster.assert;
refute = buster.refute;

buster.testCase('ObjectAdapter', {
	'the basics': {
		'should pass options to getOptions': function () {
			var bindings = {}, adaptedObject;
			adaptedObject = new ObjectAdapter({}, {
				bindings: bindings
			});
			assert.equals(bindings, adaptedObject.getOptions().bindings);
		}
	},
	'canHandle': {
		'should return true for a object literals': function () {
			assert(ObjectAdapter.canHandle({}), 'object');
		},
		'should return false for non-object literals': function () {
			refute(ObjectAdapter.canHandle(), 'undefined');
			refute(ObjectAdapter.canHandle(null), 'null');
			refute(ObjectAdapter.canHandle(function(){}), 'function');
			refute(ObjectAdapter.canHandle([]), 'array');
		}
	},
	'events': {
		'should update an object when update() called': function () {
			var obj, adapted;
			obj = { first: 'Fred', last: 'Flintstone' };
			adapted = new ObjectAdapter(obj);
			adapted.update({ first: 'Donna', last: 'Summer' });
			assert.equals(adapted._obj.first, 'Donna');
			assert.equals(adapted._obj.last, 'Summer');
		},
		'should update some properties when update() called with a partial': function () {
			var obj, adapted;
			obj = { first: 'Fred', last: 'Flintstone' };
			adapted = new ObjectAdapter(obj);
			adapted.update({ last: 'Astaire' });
			assert.equals(adapted._obj.first, 'Fred');
			assert.equals(adapted._obj.last, 'Astaire');
		}
	}
});
})(
	require('buster'),
	require('../ObjectAdapter.js')
);
