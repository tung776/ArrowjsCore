"use strict";

let SystemManager = require('./SystemManager');
let __ = require('../libs/global_function');
let _ = require('lodash');

class DemoManager extends SystemManager {
    constructor(app){
        super(app);
    }
}

module.exports = DemoManager;