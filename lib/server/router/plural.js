'use strict';

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

const express = require('express');
const _ = require('lodash');
const pluralize = require('pluralize');
const write = require('./write');
const getFullURL = require('./get-full-url');
const utils = require('../utils');
const delay = require('./delay');

module.exports = (db, name, opts) => {
  // Create router
  const router = express.Router();
  router.use(delay);
  const endpoint = parseEndpoint(name);

  // Extract the schema name. Example: if name is a-b, "a" is considered as schema name.
  function parseEndpoint(name) {
    const nameSplit = _.split(_.kebabCase(name), '-');
    const result = {};

    if (nameSplit.length > 1) {
      result.schema = nameSplit[0];
      nameSplit.shift();
      result.entity = _.camelCase(nameSplit.join('-'));
    } else {
      result.entity = _.camelCase(nameSplit.join('-'));
    }

    return result;
  }

  // Get endpoint with schema and optionnaly pluralized.
  function getEndpoint(resource, schema) {
    let _endpoint = schema ? `${schema}-${_.last(resource.split('.'))}` : `resource`;
    _endpoint = _.camelCase(_endpoint);
    _endpoint = opts.pluralize ? pluralize(_endpoint) : _endpoint;
    return _endpoint;
  }

  function getEntity(entity) {
    if (!entity) return;
    return _.last(entity.split('.'));
  }

  function getEmbedForeignKeyValue(resource, entity) {
    if (!entity) return resource.id;
    const split = entity.split('.');
    if (split.length > 1) {
      split.pop();
      const path = `${split.join('.')}${opts.foreignKeySuffix}`;
      return _.get(resource, path);
    } else {
      return resource.id;
    }
  }

  function getEmbedForeignKey(entity) {
    if (!entity) return;
    const split = entity.split('.');
    if (split.length < 2) return;
    return `${split[split.length - 2]}${opts.foreignKeySuffix}`;
  }

  // Get foreign key according to opts.foreignKeySuffix
  function getForeignKey(resource) {
    return `${resource}${opts.foreignKeySuffix}`;
  }

  // Embed function used in GET /name and GET /name/id
  function embed(resource, entity, schema = {}, alias = {}) {
    if (!(resource && entity)) return;

    const join = {};
    join.entity = alias[getEntity(entity)] || getEntity(entity);
    join.schema = schema[getEntity(entity)] || schema['default'];
    join.endpoint = getEndpoint(join.entity, join.schema);
    join.foreignKey = getEmbedForeignKey(entity) || getForeignKey(endpoint.entity);
    join.foreignKeyValue = getEmbedForeignKeyValue(resource, entity);

    if (db.get(join.endpoint).value) {
      const query = { [join.foreignKey]: join.foreignKeyValue };
      _.set(resource, entity, db.get(join.endpoint).cloneDeep().filter(query).value());
    }
  }

  // Expand function used in GET /name and GET /name/id
  function expand(resource, entity, schema = {}, alias = {}) {
    if (!(resource && entity)) return;

    const join = {};
    join.entity = alias[getEntity(entity)] || getEntity(entity);
    join.schema = schema[getEntity(entity)] || schema['default'];
    join.endpoint = getEndpoint(join.entity, join.schema);
    join.foreignKey = getForeignKey(entity);
    join.foreignKeyValue = _.get(resource, join.foreignKey);

    if (db.get(join.endpoint).value && join.foreignKeyValue) {
      _.set(resource, entity, db.get(join.endpoint).cloneDeep().getById(join.foreignKeyValue).value());
    }
  }

  // GET /name
  // GET /name?q=
  // GET /name?attr=&attr=
  // GET /name?_end=&
  // GET /name?_start=&_end=&
  // GET /name?_embed=&_expand=
  function list(req, res, next) {
    // Resource chain
    let chain = db.get(name);
    let alias = {},
        schema = {};

    // Remove q, _start, _end, ... from req.query to avoid filtering using those
    // parameters
    let q = req.query.q;
    let _start = req.query._start;
    let _end = req.query._end;
    let _page = req.query._page;
    let _sort = req.query._sort;
    let _order = req.query._order;
    let _group = req.query._group;
    let _limit = req.query._limit;
    let _embed = req.query._embed;
    let _expand = req.query._expand;
    let _alias = req.query._alias;
    let _schema = req.query._schema;
    delete req.query.q;
    delete req.query._start;
    delete req.query._end;
    delete req.query._sort;
    delete req.query._order;
    delete req.query._group;
    delete req.query._limit;
    delete req.query._embed;
    delete req.query._expand;
    delete req.query._alias;
    delete req.query._schema;

    // Get and store alias pairs
    if (_alias) {
      _alias.split(',').forEach(pair => {
        let key, value;

        var _pair$split = pair.split(':');

        var _pair$split2 = _slicedToArray(_pair$split, 2);

        key = _pair$split2[0];
        value = _pair$split2[1];

        if (!(key && value)) return;
        alias[key] = value;
      });
    }

    // Get and store schema pairs
    if (_schema) {
      _schema.split(',').forEach(pair => {
        let key, value;

        var _pair$split3 = pair.split(':');

        var _pair$split4 = _slicedToArray(_pair$split3, 2);

        key = _pair$split4[0];
        value = _pair$split4[1];

        if (!key || !value) return;
        schema[key] = value;
      });
    }

    // Get default schema from query or get it from name
    schema['default'] = schema['default'] || endpoint.schema;

    // Relations: expand and embed
    chain = chain.map(function (element) {
      // const clone = _.cloneDeep(element)

      if (_expand) {
        _expand.split(',').forEach(entity => {
          expand(element, entity, schema, alias);
        });
      }

      if (_embed) {
        _embed.split(',').forEach(entity => {
          embed(element, entity, schema, alias);
        });
      }

      return element;
    });

    // Full-text search
    if (q) {
      if (Array.isArray(q)) {
        q = q[0];
      }

      q = q.toLowerCase();

      chain = chain.filter(obj => {
        for (let key in obj) {
          const value = obj[key];
          if (db._.deepQuery(value, q)) {
            return true;
          }
        }
      });
    }

    // Filters
    // Automatically delete query parameters that can't be found
    // in the database
    Object.keys(req.query).forEach(query => {
      // const arr = db.get(name).value()
      const arr = chain.value();
      for (let i in arr) {
        if (_.has(arr[i], query) || query === 'callback' || query === '_' || /(_|\.)eq$/.test(query) || /(_|\.)ne$/.test(query) || /(_|\.)lt$/.test(query) || /(_|\.)gt$/.test(query) || /(_|\.)le$/.test(query) || /(_|\.)ge$/.test(query) || /(_|\.)lte$/.test(query) || /(_|\.)gte$/.test(query) || /(_|\.)like$/.test(query) || /(_|\.)null$/.test(query) || /(_|\.)empty$/.test(query) || /(_|\.)sort$/.test(query)) return;
      }
      delete req.query[query];
    });
    // Apply filters
    Object.keys(req.query).forEach(key => {
      // Don't take into account JSONP query parameters
      // jQuery adds a '_' query parameter too
      if (key !== 'callback' && key !== '_' && !/(_|\.)(sort)$/.test(key)) {
        // Always use an array, in case req.query is an array
        const arr = [].concat(req.query[key]);

        chain = chain.filter(element => {
          return arr.map(function (value) {
            const isEqual = /(_|\.)eq$/.test(key);
            const isDifferent = /(_|\.)ne$/.test(key);
            const isRange = /(_|\.)(le|lte|lt|ge|gte|gt)$/.test(key);
            const isLike = /(_|\.)like$/.test(key);
            const isEmpty = /(_|\.)is_empty$/.test(key);
            const isNull = /(_|\.)is_null$/.test(key);
            const path = key.replace(/(_|\.)(eq|ne|lt|le|lte|gt|gte|ge|like|is_empty|is_null)$/, '');
            // get item value based on path
            // i.e post.title -> 'foo'
            const elementValue = _.get(element, path);
            const hasElementValue = typeof elementValue !== 'undefined' && elementValue !== null;

            if (isNull) {
              return !hasElementValue;
            }

            if (isRange) {
              const isLowerOrEqual = /(_|\.)(le|lte)$/.test(key);
              const isLowerThan = /(_|\.)lt$/.test(key);
              const isGreaterOrEqual = /(_|\.)(ge|gte)$/.test(key);
              const isGreaterThan = /(_|\.)gt$/.test(key);

              if (isLowerOrEqual) {
                return value >= elementValue;
              } else if (isLowerThan) {
                return value > elementValue;
              } else if (isGreaterOrEqual) {
                return value <= elementValue;
              } else if (isGreaterThan) {
                return value < elementValue;
              }
            }

            if (hasElementValue) {
              if (isEqual) {
                return value === elementValue.toString();
              } else if (isDifferent) {
                return value !== elementValue.toString();
              } else if (isLike) {
                return new RegExp(value, 'i').test(elementValue.toString());
              } else if (isEmpty) {
                return elementValue.length === 0;
              } else {
                return value === elementValue.toString();
              }
            }
          }).reduce((a, b) => a || b);
        });
      }
    });

    // Sort 
    if (_sort) {
      const _sortSet = _sort.split(',');
      const _orderSet = (_order || '').split(',').map(s => s.toLowerCase());
      chain = chain.orderBy(_sortSet, _orderSet);
    } else {
      // Alternative for sorting
      const sortArr = Object.keys(req.query).filter(param => /(_|\.)sort$/.test(param));
      sortArr.forEach(function (value) {
        const _sortSet = [];
        const _orderSet = [];
        _sortSet.push(value.replace(/(_|\.)sort$/, ''));
        _orderSet.push(req.query[value]);
        chain = chain.orderBy(_sortSet, _orderSet);
      });
    }

    // Group
    if (_group) {
      if (!_group || _group.length === 0) return;
      const arr = chain.value();
      if (arr.find(e => _.get(e, _group))) {
        chain = chain.reduce(function (r, a) {
          const groupValue = _.get(a, _group);
          r[groupValue] = r[groupValue] || [];
          r[groupValue].push(a);
          return r;
        }, Object.create(null)).transform((result, value, key) => {
          result.push({ group: key, data: value });
        }, []);
      }
    }

    // Slice result
    if (_end || _limit || _page) {
      res.setHeader('X-Total-Count', chain.size());
      res.setHeader('Access-Control-Expose-Headers', `X-Total-Count${_page ? ', Link' : ''}`);
    }

    // Pagination
    if (_page) {
      _page = parseInt(_page, 10);
      _page = _page >= 1 ? _page : 1;
      _limit = parseInt(_limit, 10) || 10;
      const page = utils.getPage(chain.value(), _page, _limit);
      const links = {};
      const fullURL = getFullURL(req);

      if (page.first) {
        links.first = fullURL.replace(`page=${page.current}`, `page=${page.first}`);
      }

      if (page.prev) {
        links.prev = fullURL.replace(`page=${page.current}`, `page=${page.prev}`);
      }

      if (page.next) {
        links.next = fullURL.replace(`page=${page.current}`, `page=${page.next}`);
      }

      if (page.last) {
        links.last = fullURL.replace(`page=${page.current}`, `page=${page.last}`);
      }

      res.links(links);
      chain = _.chain(page.items);
    } else if (_end) {
      _start = parseInt(_start, 10) || 0;
      _end = parseInt(_end, 10);
      chain = chain.slice(_start, _end);
    } else if (_limit) {
      _start = parseInt(_start, 10) || 0;
      _limit = parseInt(_limit, 10);
      chain = chain.slice(_start, _start + _limit);
    }

    res.locals.data = chain.value();
    next();
  }

  // GET /name/:id
  // GET /name/:id?_embed=&_expand
  function show(req, res, next) {
    let alias = {},
        schema = {};
    const _embed = req.query._embed;
    const _expand = req.query._expand;
    const _alias = req.query.alias;
    const _schema = req.query.schema;
    const resource = db.get(name).getById(req.params.id).value();

    // Get and store alias pairs
    if (_alias) {
      _alias.split(',').forEach(pair => {
        let key, value;

        var _pair$split5 = pair.split(':');

        var _pair$split6 = _slicedToArray(_pair$split5, 2);

        key = _pair$split6[0];
        value = _pair$split6[1];

        if (!(key && value)) return;
        alias[key] = value;
      });
    }

    // Get and store schema pairs
    if (_schema) {
      _schema.split(',').forEach(pair => {
        let key, value;

        var _pair$split7 = pair.split(':');

        var _pair$split8 = _slicedToArray(_pair$split7, 2);

        key = _pair$split8[0];
        value = _pair$split8[1];

        if (!key || !value) return;
        schema[key] = value;
      });
    }

    // Get default schema from query or get it from name
    schema['default'] = schema['default'] || endpoint.schema;

    if (resource) {
      // Clone resource to avoid making changes to the underlying object
      const clone = _.cloneDeep(resource);

      // Expand inner resources based on id
      // /posts/1?_expand=user
      if (_expand) {
        _expand.split(',').forEach(entity => {
          expand(clone, entity, schema, alias);
        });
      }

      // Embed other resources based on resource id
      // /posts/1?_embed=comments
      if (_embed) {
        _embed.split(',').forEach(entity => {
          embed(clone, entity, schema, alias);
        });
      }

      res.locals.data = clone;
    }

    next();
  }

  // POST /name
  function create(req, res, next) {
    const resource = db.get(name).insert(req.body).value();

    res.setHeader('Access-Control-Expose-Headers', 'Location');
    res.location(`${getFullURL(req)}/${resource.id}`);

    res.status(201);
    res.locals.data = resource;

    next();
  }

  // PUT /name/:id
  // PATCH /name/:id
  function update(req, res, next) {
    const id = req.params.id;
    let chain = db.get(name);

    chain = req.method === 'PATCH' ? chain.updateById(id, req.body) : chain.replaceById(id, req.body);

    const resource = chain.value();

    if (resource) {
      res.locals.data = resource;
    }

    next();
  }

  // DELETE /name/:id
  function destroy(req, res, next) {
    const resource = db.get(name).removeById(req.params.id).value();

    if (opts.cascade) {
      // Remove dependents documents
      const removable = db._.getRemovable(db.getState(), opts);
      removable.forEach(item => {
        db.get(item.name).removeById(item.id).value();
      });
    }

    if (resource) {
      res.locals.data = {};
    }

    next();
  }

  const w = write(db);

  router.route('/').get(list).post(create, w);

  router.route('/:id').get(show).put(update, w).patch(update, w).delete(destroy, w);

  return router;
};