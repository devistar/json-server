const express = require('express')
const _ = require('lodash')
const pluralize = require('pluralize')
const write = require('./write')
const getFullURL = require('./get-full-url')
const utils = require('../utils')
const delay = require('./delay')

module.exports = (db, name, opts) => {
  // Create router
  const router = express.Router()
  router.use(delay)

  // Embed function used in GET /name and GET /name/id
  // _embed=(schema.)entity,...
  function embed(resource, e) {
    if (resource && e) {
      let split = _.split(_.kebabCase(name), '-')
      const resourceSchema = split.length > 1 ? split[0] : undefined
      const resourceName = split.length > 1 ?
        _.camelCase(_.join(_.drop(split), '-'))
        : split[0]
      e.split(",").forEach(embedResource => {
        split = _.split(embedResource, '.')
        const embedSchema = split.length === 1 ? resourceSchema : split[0]
        const embedName = split.length > 1 ? split[1] : split[0]
        let embedFullName = _.camelCase(_.join([embedSchema, '-', embedName], ''))
        embedFullName = opts.pluralize ? pluralize(embedFullName) : embedFullName
        if (db.get(embedFullName).value) {
          const query = {}
          query[`${resourceName}${opts.foreignKeySuffix}`] = resource.id
          resource[embedName] = db
            .get(embedFullName)
            .filter(query)
            .value()
        }
      })
    }
  }

  // Expand function used in GET /name and GET /name/id
  // _expand=(schema.)entity,...
  // default foreign key: entityId
  function expand(resource, e) {
    if (resource, e) {
      e.split(",").forEach(joinResource => {
        const split = _.split(joinResource, '.')
        const joinName = split.length > 1 ? split[1] : split[0]
        const foreignKey = `${joinName}${opts.foreignKeySuffix}`
        join(resource, joinResource, foreignKey)
      })
    }
  }

  // Expand for a defined resource
  // fkColumn_join=(schema.)entity
  // schema is optional, if undefined it uses resource schema.
  function join(resource, joinResource, foreignKey) {
    if (resource && joinResource && foreignKey) {
      let split = _.split(_.kebabCase(name), '-')
      const schema = split.length > 1 ? split[0] : undefined
      split = _.split(joinResource, '.')
      const joinSchema = split.length === 1 ? schema : split[0]
      const joinName = split.length > 1 ? split[1] : split[0]
      let joinFullName = _.camelCase(_.join([joinSchema, '-', joinName], ''))
      joinFullName = opts.pluralize ? pluralize(joinFullName) : joinFullName
      const fkValue = resource[foreignKey]
      if (joinName && joinFullName && fkValue) {
        resource[joinName] = db
          .get(joinFullName)
          .getById(fkValue)
          .value()
      }
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

    // Remove q, _start, _end, ... from req.query to avoid filtering using those
    // parameters
    let q = req.query.q
    let _start = req.query._start
    let _end = req.query._end
    let _page = req.query._page
    let _sort = req.query._sort
    let _order = req.query._order
    let _limit = req.query._limit
    let _embed = req.query._embed
    let _expand = req.query._expand
    delete req.query.q
    delete req.query._start
    delete req.query._end
    delete req.query._sort
    delete req.query._order
    delete req.query._limit
    delete req.query._embed
    delete req.query._expand

    // Join
    const joinArr = Object.keys(req.query).filter(param => /(_|\.)join$/.test(param))
    chain = chain.map(function (element) {
      const clone = _.cloneDeep(element)
      // Mapped join
      joinArr.forEach(function (val) {
        const joinResource = req.query[val]
        const foreignKey = val.replace(/(_|\.)join$/, '')
        join(clone, joinResource, foreignKey)
      })
      embed(clone, _embed)
      // Auto join
      expand(clone, _expand)
      return clone;
    })

    // Automatically delete query parameters that can't be found
    // in the database
    Object.keys(req.query).forEach(query => {
      const arr = db.get(name).value()
      for (let i in arr) {
        if (
          _.has(arr[i], query) ||
          query === 'callback' ||
          query === '_' ||
          /(_|\.)eq$/.test(query) ||
          /(_|\.)ne$/.test(query) ||
          /(_|\.)lt$/.test(query) ||
          /(_|\.)gt$/.test(query) ||
          /(_|\.)le$/.test(query) ||
          /(_|\.)ge$/.test(query) ||
          /(_|\.)lte$/.test(query) ||
          /(_|\.)gte$/.test(query) ||
          /(_|\.)like$/.test(query) ||
          /(_|\.)null$/.test(query) ||
          /(_|\.)empty$/.test(query) ||
          /(_|\.)sort$/.test(query) ||
          /(_|\.)join$/.test(query)
        )
          return
      }
      delete req.query[query]
    })

    if (q) {
      // Full-text search
      if (Array.isArray(q)) {
        q = q[0]
      }

      q = q.toLowerCase()

      chain = chain.filter(obj => {
        for (let key in obj) {
          const value = obj[key]
          if (db._.deepQuery(value, q)) {
            return true
          }
        }
      })
    }

    // Filters
    Object.keys(req.query).forEach(key => {
      // Don't take into account JSONP query parameters
      // jQuery adds a '_' query parameter too
      if (key !== 'callback' && key !== '_' && !/(_|\.)(join|sort)$/.test(key)) {
        // Always use an array, in case req.query is an array
        const arr = [].concat(req.query[key])

        chain = chain.filter(element => {
          return arr
            .map(function (value) {
              const isEqual = /(_|\.)eq$/.test(key)
              const isDifferent = /(_|\.)ne$/.test(key)
              const isRange = /(_|\.)(le|lte|lt|ge|gte|gt)$/.test(key)
              const isLike = /(_|\.)like$/.test(key)
              const isEmpty = /(_|\.)is_empty$/.test(key)
              const isNull = /(_|\.)is_null$/.test(key)
              const path = key.replace(
                /(_|\.)(eq|ne|lt|le|lte|gt|gte|ge|like|is_empty|is_null)$/,
                ''
              )
              // get item value based on path
              // i.e post.title -> 'foo'
              const elementValue = _.get(element, path)
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
            })
            .reduce((a, b) => a || b)
        })
      }
    })

    // Sort 
    if (_sort) {
      const _sortSet = _sort.split(',')
      const _orderSet = (_order || '').split(',').map(s => s.toLowerCase())
      chain = chain.orderBy(_sortSet, _orderSet)
    } else {
      // Alternative for sorting
      const sortArr = Object.keys(req.query).filter(param => /(_|\.)sort$/.test(param))
      sortArr.forEach(function (value) {
        const _sortSet = []
        const _orderSet = []
        _sortSet.push(value.replace(/(_|\.)sort$/, ''))
        _orderSet.push(req.query[value])
        chain = chain.orderBy(_sortSet, _orderSet)
      })
    }

    // Slice result
    if (_end || _limit || _page) {
      res.setHeader('X-Total-Count', chain.size())
      res.setHeader(
        'Access-Control-Expose-Headers',
        `X-Total-Count${_page ? ', Link' : ''}`
      )
    }

    // Pagination
    if (_page) {
      _page = parseInt(_page, 10)
      _page = _page >= 1 ? _page : 1
      _limit = parseInt(_limit, 10) || 10
      const page = utils.getPage(chain.value(), _page, _limit)
      const links = {}
      const fullURL = getFullURL(req)

      if (page.first) {
        links.first = fullURL.replace(
          `page=${page.current}`,
          `page=${page.first}`
        )
      }

      if (page.prev) {
        links.prev = fullURL.replace(
          `page=${page.current}`,
          `page=${page.prev}`
        )
      }

      if (page.next) {
        links.next = fullURL.replace(
          `page=${page.current}`,
          `page=${page.next}`
        )
      }

      if (page.last) {
        links.last = fullURL.replace(
          `page=${page.current}`,
          `page=${page.last}`
        )
      }

      res.links(links)
      chain = _.chain(page.items)
    } else if (_end) {
      _start = parseInt(_start, 10) || 0
      _end = parseInt(_end, 10)
      chain = chain.slice(_start, _end)
    } else if (_limit) {
      _start = parseInt(_start, 10) || 0
      _limit = parseInt(_limit, 10)
      chain = chain.slice(_start, _start + _limit)
    }

    res.locals.data = chain.value()
    next()
  }

  // GET /name/:id
  // GET /name/:id?_embed=&_expand
  function show(req, res, next) {
    const _embed = req.query._embed
    const _expand = req.query._expand
    const resource = db
      .get(name)
      .getById(req.params.id)
      .value()

    if (resource) {
      // Clone resource to avoid making changes to the underlying object
      const clone = _.cloneDeep(resource)

      // Embed other resources based on resource id
      // /posts/1?_embed=comments
      embed(clone, _embed)

      // Expand inner resources based on id
      // /posts/1?_expand=user
      expand(clone, _expand)

      res.locals.data = clone
    }

    next()
  }

  // POST /name
  function create(req, res, next) {
    const resource = db
      .get(name)
      .insert(req.body)
      .value()

    res.setHeader('Access-Control-Expose-Headers', 'Location')
    res.location(`${getFullURL(req)}/${resource.id}`)

    res.status(201)
    res.locals.data = resource

    next()
  }

  // PUT /name/:id
  // PATCH /name/:id
  function update(req, res, next) {
    const id = req.params.id
    let chain = db.get(name)

    chain =
      req.method === 'PATCH'
        ? chain.updateById(id, req.body)
        : chain.replaceById(id, req.body)

    const resource = chain.value()

    if (resource) {
      res.locals.data = resource
    }

    next()
  }

  // DELETE /name/:id
  function destroy(req, res, next) {
    const resource = db
      .get(name)
      .removeById(req.params.id)
      .value()

    if (opts.cascade) {
      // Remove dependents documents
      const removable = db._.getRemovable(db.getState(), opts)
      removable.forEach(item => {
        db.get(item.name)
          .removeById(item.id)
          .value()
      })
    }

    if (resource) {
      res.locals.data = {}
    }

    next()
  }

  const w = write(db)

  router
    .route('/')
    .get(list)
    .post(create, w)

  router
    .route('/:id')
    .get(show)
    .put(update, w)
    .patch(update, w)
    .delete(destroy, w)

  return router
}
