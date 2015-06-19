'use strict';

let util = require('util'),
    _ = require('lodash');

function IndexModule() {
    BaseModuleFrontend.call(this);
    this.path = "/dashboard";
}

let _module = new IndexModule();
_module.index = function (req, res) {
    let index_view = 'index';
    _module.render(req, res, index_view, {
        user: req.user || null
    });
};

util.inherits(IndexModule, BaseModuleFrontend);
module.exports = _module;