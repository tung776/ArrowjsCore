'use strict';

/**
 * Module dependencies.
 */
let fs = require('fs'),
    arrowStack = require('./ArrStack'),
    path = require('path'),
    express = require('express'),
    _ = require('lodash'),
    Promise = require('bluebird'),
    RedisCache = require("./RedisCache"),
    logger = require("./logger"),
    __ = require("./global_function"),
    EventEmitter = require('events').EventEmitter,
    Database = require('./database'),
    DefaultManager = require("../manager/DefaultManager"),
    ConfigManager = require("../manager/ConfigManager"),
    buildStructure = require("./buildStructure"),
    socket_io = require('socket.io'),
    http = require('http'),
    cluster = require('cluster'),
    socketRedisAdapter = require('socket.io-redis'),
    loadingLanguage = require("./i18n").loadLanguage;
/**
 * Singleton object. It is heart of Arrowjs.io web app. it wraps Express and adds following functions:
 * support Redis, multi-languages, passport, check permission and socket.io / websocket
 */
class ArrowApplication {

    /**
     * Constructor
     * @param setting
     */
    constructor(setting) {
        //if NODE_ENV does not exist, use development by default
        process.env.NODE_ENV = process.env.NODE_ENV || 'development';

        this.beforeAuth = [];  //add middle-wares before user authenticates
        this.afterAuth = [];   //add middle-ware after user authenticates
        this._expressApplication = express();  //wrap express object

        //Move all functions of express to ArrowApplication
        //So we can call ArrowApplication.listen(port)
        let self = this._expressApplication;
        for (let func in self) {
            if (typeof self[func] == 'function') {
                this[func] = self[func].bind(self);
            } else {
                this[func] = self[func]
            }
        }

        // 0 : location of this file
        // 1 : location of index.js (module file)
        // 2 : location of server.js file
        let requester = arrowStack(2);
        this.arrFolder = path.dirname(requester) + '/';

        //assign current Arrowjs application folder to global variable
        global.__base = this.arrFolder;

        //Read config/config.js into this._config
        this._config = __.getRawConfig();

        //Read and parse config/structure.js
        this.structure = buildStructure(__.getStructure());

        //display longer stack trace in console
        if (this._config.long_stack) {
            require('longjohn')
        }

        //Make redis cache
        let redisConfig = this._config.redis || {};
        let redisFunction = RedisCache(redisConfig);
        var redisClient, redisSubscriber;

        /* In config/env/development.js , section Redis:
         if real Redis server is not available, set type = 'fakeredis'
         if real Redis server present, set type = 'redis', host and port correctly
        */
        if (redisConfig.type === "fakeredis") {
            redisClient = redisFunction("client");
            redisSubscriber = redisFunction.bind(null, redisConfig);
        } else {
            redisClient = redisFunction(redisConfig);
            redisSubscriber = redisFunction.bind(null, redisConfig);
        }

        this.redisClient = redisClient;
        this.redisSubscriber = redisSubscriber;

        //Add passport and its authentication strategies
        this.usePassport = require("../config/middleware/loadPassport");

        //Display flash message when user reloads view
        this.useFlashMessage = require("../config/middleware/flashMessage");

        //Use middleware express-session to store user session
        this.useSession = require("../config/middleware/useSession");

        //Serve static resources when not using Nginx.
        //See config/view.js section resource
        this.serveStatic = require("../config/middleware/staticResource");

        //Load available languages. See config/i18n.js and folder /lang
        loadingLanguage(this._config);

        //Bind all global functions to ArrowApplication object
        loadingGlobalFunction(this);


        this.configManager = new ConfigManager(this, "config");

        //Share eventEmitter among all kinds of Managers. This helps Manager object notifies each other
        //when configuration is changed
        let eventEmitter = new EventEmitter();

        //subscribes to get notification from shared eventEmitter object
        this.configManager.eventHook(eventEmitter);

        //Create shortcut call
        this.getConfig = this.configManager.getConfig.bind(this.configManager);
        this.setConfig = this.configManager.setConfig.bind(this.configManager);
        this.updateConfig = this.configManager.updateConfig.bind(this.configManager);

        //_componentList contains name property of composite features, singleton features, widgets, plugins
        this._componentList = [];
        Object.keys(this.structure).map(function (managerKey) {
            let key = managerKey;
            let managerName = managerKey + "Manager";
            this[managerName] = new DefaultManager(this, key);
            this[managerName].eventHook(eventEmitter);
            this[managerName].loadComponents(key);
            this[key] = this[managerName]["_" + key];
            this._componentList.push(key);
        }.bind(this));

        //Declare _arrRoutes to store all routes of features
        this._arrRoutes = {};
    }

    /**
     *
     * @param func
     */
    beforeAuthenticate(func) {
        let self = this;
        if (typeof func == "function") {
            self.beforeAuth.push(func.bind(self));
        }
    }

    /**
     *
     * @param func
     */
    afterAuthenticate(func) {
        let self = this;
        if (typeof func == "function") {
            self.afterAuth.push(func.bind(self));
        }
    }

    /**
     * Kick start express application and listen at default port
     * @returns {Promise.<T>}
     */
    start(setting) {
        let self = this;
        /** Init the express application */
        return Promise.resolve()
            .then(function () {
                addRoles(self);
                if (self.getConfig("redis.type") !== "fakeredis") {
                    //TODO : testing auto load config if use redis
                    let resolve = self.configManager.getCache();
                    self._componentList.map(function (key) {
                        let managerName = key + "Manager";
                        resolve = resolve.then(function () {
                            return self[managerName].getCache()
                        })
                    });
                    return resolve
                } else {
                    return Promise.resolve();
                }
            })
            .then(function () {
                return expressApp(self, self.getConfig(), setting)
            })
            .then(function () {
                return loadRouteAndRender(self, setting);
            })
            .then(function (app) {
                let server = http.createServer(self._expressApplication);

                if (self.getConfig('websocket_enable') && self.getConfig('websocket_folder')) {
                    let io = socket_io(server);
                    if (self.getConfig('redis.type') !== 'fakeredis') {
                        let redisConf = {host: self.getConfig('redis.host'), port: self.getConfig('redis.port')};
                        io.adapter(socketRedisAdapter(redisConf));
                    }
                    self.io = io;

                    __.getGlobbedFiles(path.normalize(self.arrFolder + self.getConfig('websocket_folder'))).map(function (link) {
                        let socketFunction = require(link);
                        if(_.isFunction(socketFunction)) {
                            socketFunction(io);
                        }
                    })
                }

                server.listen(self.getConfig("port"), function () {
                    logger.info('Application loaded using the "' + process.env.NODE_ENV + '" environment configuration');
                    logger.info('Application started on port ' + self.getConfig("port"), ', Process ID: ' + process.pid);
                });
                return app;
            });

    }
}

/**
 * Supporting functions
 */


/**
 *
 * @param arrow
 * @param userSetting
 */
function loadRouteAndRender(arrow, userSetting) {
    let defaultDatabase = {};
    let defaultQueryResolve = function () {
        return new Promise(function (fulfill, reject) {
            fulfill("No models")
        })
    };
    if (arrow.models && Object.keys(arrow.models).length > 0) {
        if (_.isEmpty(defaultDatabase)) {
            defaultDatabase = Database(arrow);
        }
        arrow.models.rawQuery = defaultDatabase.query ? defaultDatabase.query.bind(defaultDatabase) : defaultQueryResolve;

        //New way to associate db:

        let databaseFunction = require(arrow.arrFolder + "config/database");

        if (databaseFunction.associate) {
            databaseFunction.associate(arrow.models)
        }

    }


    if (!_.isEmpty(defaultDatabase)) {
        defaultDatabase.sync();
    }

    arrow._componentList.map(function (key) {
        Object.keys(arrow[key]).map(function (componentKey) {
            if (cluster.isMaster) {
                logger.info("Arrow loaded: '" + key + "' - '" + componentKey + "'");
            }
            let routeConfig = arrow[key][componentKey]._structure.route;
            if (routeConfig) {
                Object.keys(routeConfig.path).map(function (second_key) {
                    let defaultRouteConfig = routeConfig.path[second_key];
                    if (arrow[key][componentKey].routes[second_key]) {
                        let componentRouteSetting = arrow[key][componentKey].routes[second_key];
                        handleComponentRouteSetting(arrow, componentRouteSetting, defaultRouteConfig, key, userSetting, componentKey);
                    } else {

                        let componentRouteSetting = arrow[key][componentKey].routes;
                        //Handle Route Path;
                        handleComponentRouteSetting(arrow, componentRouteSetting, defaultRouteConfig, key, userSetting, componentKey);
                    }
                });
            }
        })
    })
}

/**
 *
 * @param app
 * @returns {*}
 */
function expressApp(app, config, setting) {
    return new Promise(function (fulfill, reject) {
        let expressFunction;
        if (fs.existsSync(path.resolve(app.arrFolder + "config/express.js"))) {
            expressFunction = require(app.arrFolder + "config/express");
        } else {
            expressFunction = require("../config/express");
        }
        fulfill(expressFunction(app, config, setting));
    });
}


/**
 *
 * @param arrow
 * @param componentRouteSetting
 * @param defaultRouteConfig
 * @param key
 * @param setting
 * @param componentKey
 */
function handleComponentRouteSetting(arrow, componentRouteSetting, defaultRouteConfig, key, setting, componentKey) {
    let component = arrow[key][componentKey];
    let componentName = arrow[key][componentKey].name;
    let viewInfo = arrow[key][componentKey].views;
    //Handle Route Path;
    let route = express.Router();
    Object.keys(componentRouteSetting).map(function (path_name) {

        //Check path_name
        let routePath = path_name[0] === '/' ? path_name : "/" + componentName + "/" + path_name;

        //handle prefix
        if (defaultRouteConfig.prefix && defaultRouteConfig.prefix[0] !== "/") {
            defaultRouteConfig.prefix = "/" + defaultRouteConfig.prefix
        }
        let prefix = defaultRouteConfig.prefix || '/';

        let arrayMethod = Object.keys(componentRouteSetting[path_name]).filter(function (method) {
            if (componentRouteSetting[path_name][method].name) {
                arrow._arrRoutes[componentRouteSetting[path_name][method].name] = path.normalize(prefix + routePath);
            }

            //handle function
            let routeHandler = componentRouteSetting[path_name][method].handler;
            let authenticate = componentRouteSetting[path_name][method].authenticate !== undefined ? componentRouteSetting[path_name][method].authenticate : defaultRouteConfig.authenticate;

            let arrayHandler = [];
            if (arrayHandler && _.isArray(routeHandler)) {
                arrayHandler = routeHandler.filter(function (func) {
                    if (_.isFunction(func)) {
                        return func
                    }
                });
            } else if (_.isFunction(routeHandler)) {
                arrayHandler.push(routeHandler)
            } else if (!_.isString(authenticate)) {
                return
            }

            //Add viewRender
            if (!_.isEmpty(viewInfo) && !_.isString(authenticate)) {
                arrayHandler.splice(0, 0, overrideViewRender(arrow, viewInfo, componentName, component, key))
            }


            //handle role
            if (setting && setting.role) {
                let permissions = componentRouteSetting[path_name][method].permissions;
                if (permissions && !_.isString(authenticate)) {
                    arrayHandler.splice(0, 0, arrow.passportSetting.handlePermission);
                    arrayHandler.splice(0, 0, handleRole(arrow, permissions, componentName, key))
                }
            }

            //add middleware after authenticate;
            if (!_.isEmpty(arrow.afterAuth)) {
                arrow.afterAuth.map(function (func) {
                    arrayHandler.splice(0, 0, func)
                })
            }

            //handle Authenticate
            if (setting && setting.passport) {
                if (authenticate) {
                    arrayHandler.splice(0, 0, handleAuthenticate(arrow, authenticate))
                }
            }

            //add middleware before authenticate;
            if (!_.isEmpty(arrow.beforeAuth)) {
                arrow.beforeAuth.map(function (func) {
                    arrayHandler.splice(0, 0, func)
                })
            }

            //Add to route
            if (method === "param") {
                if (_.isString(componentRouteSetting[path_name][method].key) && !_.isArray(componentRouteSetting[path_name][method].handler)) {
                    return route.param(componentRouteSetting[path_name][method].key, componentRouteSetting[path_name][method].handler);
                }
            } else if (method === 'all') {
                return route.route(routePath)
                    [method](arrayHandler);
            } else if (route[method] && ['route', 'use'].indexOf(method) === -1) {
                return route.route(routePath)
                    [method](arrayHandler)
            }
        });
        !_.isEmpty(arrayMethod) && arrow.use(prefix, route);
    });
}
/**
 *
 * @param application
 * @param componentView
 * @param componentName
 * @param component
 * @returns {Function}
 */
function overrideViewRender(application, componentView, componentName, component, key) {
    return function (req, res, next) {
        // Grab reference of render
        req.arrowUrl = key + "." + componentName;

        let _render = res.render;
        let self = this;
        if (_.isArray(componentView)) {
            res.render = makeRender(req, res, application, componentView, componentName, component);
        } else {
            Object.keys(componentView).map(function (key) {
                res[key] = res[key] || {};
                res[key].render = makeRender(req, res, application, componentView[key], componentName, component[key]);
            });
            res.render = res[Object.keys(componentView)[0]].render
        }
        next();
    }
}
/**
 *
 * @param req
 * @param res
 * @param application
 * @param componentView
 * @param componentName
 * @param component
 * @returns {Function}
 */
function makeRender(req, res, application, componentView, componentName, component) {
    return function (view, options, callback) {

        var done = callback;
        var opts = options || {};

        // merge res.locals
        _.assign(opts, res.locals);

        //remove flash message
        delete req.session.flash;

        // support callback function as second arg
        if (typeof options === 'function') {
            done = options;
            opts = res.locals || {};
        }

        // default callback to respond
        done = done || function (err, str) {
            if (err) return req.next(err);
            res.send(str);
        };

        if (application._config.viewExtension && view.indexOf(application._config.viewExtension) === -1 && view.indexOf(".") === -1) {
            view += "." + application._config.viewExtension;
        }
        component.viewEngine.loaders[0].pathsToNames = {};
        component.viewEngine.loaders[0].cache = {};
        component.viewEngine.loaders[0].searchPaths = componentView.map(function (obj) {
            return handleView(obj, application, componentName);
        });

        component.viewEngine.render(view, opts, done);
    };
}

/**
 *
 * @param obj
 * @param application
 * @param componentName
 * @returns {*}
 */
function handleView(obj, application, componentName) {
    let miniPath = obj.func(application._config, componentName);
    let normalizePath;
    if (miniPath[0] === "/") {
        normalizePath = path.normalize(obj.base + "/" + miniPath);
    } else {
        normalizePath = path.normalize(obj.fatherBase + "/" + miniPath)
    }
    return normalizePath
}

function handleAuthenticate(application, name) {
    let passport = application.passport;
    if (_.isString(name)) {
        if (application.passportSetting[name]) {
            let strategy = application.passportSetting[name].strategy || name;
            let callback = application.passportSetting[name].callback;
            let option = application.passportSetting[name].option || {};
            if (callback) return passport.authenticate(strategy, option, callback);
            return passport.authenticate(strategy, option);
        }
    } else if (_.isBoolean(name)) {
        if (application.passportSetting.checkAuthenticate && _.isFunction(application.passportSetting.checkAuthenticate)) {
            return application.passportSetting.checkAuthenticate
        }
    }
    return function (req, res, next) {
        next()
    }
}
/**
 *
 * @param application
 * @param permissions
 * @param componentName
 * @param key
 * @returns {handleRoles}
 */
function handleRole(application, permissions, componentName, key) {
    let arrayPermissions = [];
    if (_.isArray(permissions)) {
        arrayPermissions = permissions
    } else {
        arrayPermissions.push(permissions);
    }
    return function handleRoles(req, res, next) {
        req.permissions = req.session.permissions;
        if (req.permissions && req.permissions[key] && req.permissions[key][componentName]) {
            let checkedPermission = req.permissions[key][componentName].filter(function (key) {
                if (arrayPermissions.indexOf(key.name) > -1) {
                    return key
                }
            }).map(function (data) {
                return data.name
            });
            if (!_.isEmpty(checkedPermission)) {
                req.permissions = checkedPermission;
                req.hasPermission = true
            }
        } else {
            req.hasPermission = false;
        }
        next();
    }
}
/**
 * Load global functions then append to global.ArrowHelper
 * bind global function to ArrowApplication object so dev can this keyword in that function to refer
 * ArrowApplication object
 * @param self: ArrowApplication object
 */
function loadingGlobalFunction(self) {
    global.ArrowHelper = {};
    __.getGlobbedFiles(path.resolve(__dirname, "..", "helpers/*.js")).map(function (link) {
        let arrowObj = require(link);
        Object.keys(arrowObj).map(function (key) {
            if (_.isFunction(arrowObj[key])) {
                ArrowHelper[key] = arrowObj[key].bind(self)
            } else {
                ArrowHelper[key] = arrowObj[key]
            }
        })
    });
    __.getGlobbedFiles(path.normalize(__base + self._config.ArrowHelper + "*.js")).map(function (link) {
        let arrowObj = require(link);
        Object.keys(arrowObj).map(function (key) {
            if (_.isFunction(arrowObj[key])) {
                ArrowHelper[key] = arrowObj[key].bind(self)
            } else {
                ArrowHelper[key] = arrowObj[key]
            }
        })
    });

    //Add some support function
    global.__ = ArrowHelper.__
}


function addRoles(self) {
    self.permissions = {};
    self._componentList.map(function (key) {
        let managerName = key + "Manager";
        self.permissions[key] = self[managerName].getPermissions();
    });
}
module.exports = ArrowApplication;