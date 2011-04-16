"use strict";

// Capture the output of this into a variable, if you want
(function(Module, args, print) {
//  Module = Module || {};
//  args = args || [];

// Runs much faster, for some reason
// this['Module'] = {};
// var args = arguments;

  {{BODY}}

  // {{MODULE_ADDITIONS}}

  return Module;
})({}, process.argv.slice(2), console.log) ; // Replace parameters as needed

