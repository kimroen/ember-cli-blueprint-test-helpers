'use strict';

var ember       = require('ember-cli/tests/helpers/ember');
var Promise     = require('ember-cli/lib/ext/promise');
var path        = require('path');
var findup      = Promise.denodeify(require('findup'));
var initProject = require('./project-init');
var expect      = require('chai').expect;
var walkSync    = require('walk-sync');
var assertFile  = require('ember-cli-internal-test-helpers/lib/helpers/assert-file');
var assertFileToNotExist  = require('ember-cli-internal-test-helpers/lib/helpers/assert-file-to-not-exist');
var tmpenv      = require('./tmp-env');
var debug       = require('debug')('ember-cli:testing');
var fs          = require('fs');
var teardownProject = require('./project-teardown');

/**
  Generate blueprint then assert generated contents against options.files
  @method generate
  @param {Array} [args]
  @param {Object} [options]
  @param {Array} [options.files]
  @param {RegExp|Object} [options.throws]
  @return {Command}
*/
function generate(args, options) {
  var fileAssertions = options.files || [];
  var command = processCommand('generate', args, options)
    .then(assertGenerated.bind(null, fileAssertions));

  if (options.throws) {
    return assertThrows(command, options, options.throws);
  }
  return command;
}

/**
  Destroy blueprint then assert options.files destroyed
  @method destroy
  @param {Array} [args]
  @param {Object} [options]
  @param {Array} [options.files]
  @param {RegExp|Object} [options.throws]
  @return {Command}
*/
function destroy(args, options) {
  var fileAssertions = options.files || [];
  var command = processCommand('destroy', args, options)
    .then(assertDestroyed.bind(null, fileAssertions));

  if (options.throws) {
    return assertThrows(command, options, options.throws);
  }
  return command;
}

/**
  Generate blueprint and assert contents, then destroy blueprint and assert destroyed
  @method generateAndDestroy
  @param {Array} [args]
  @param {Object} [options]
  @param {Array} [options.files]
  @param {Array} [options.assertions]
  @param {RegExp|Object} [options.throws]
  @return {Command}
*/
function generateAndDestroy(args, options) {
  var assertions = options.assertions || [];
  var fileAssertions = options.files || [];
  var command = processCommand('generate', args, options)
    .then(assertGenerated.bind(null, fileAssertions))
    .then(processAssertions.bind(null, assertions))
    .then(function() {
      options.skipInit = true;
      options.teardown = true;
      return processCommand('destroy', args, options);
    })
    .then(assertDestroyed.bind(null, fileAssertions));

  if (options.throws) {
    return assertThrows(command, options, options.throws);
  }
  return command;
}

/**
  Process command. Initializes a new project to process the command
  on, then does teardown afterwards.
  @function processCommand
  @param {String} command
  @param {Array} [args]
  @param {Object} [options]
  @param {String} [options.target]
  @param {Path} [options.root]
  @param {Object} [options.package]
  @param {Function} [options.beforeGenerate]
  @param {Function} [options.afterGenerate]
  @param {Function} [options.beforeDestroy]
  @param {Function} [options.afterDestroy]
  @return {Promise}
*/
function processCommand(command, args, options) {
  var commandArgs = [command].concat(args);
  var type = (options.target === 'inRepoAddon') ? 'app' : (options.target ? options.target : 'app');
  var projectRoot = options.root || getProjectRoot(process.cwd());
  var mockPackage = options.package || getPackage(projectRoot, type);
  var cliOptions = {
    type: type,
    disableDependencyChecker: true,
    package: mockPackage
  };
  var beforeProcess = function() {return;};
  var afterProcess = function() {return;};

  if (options && options.target === 'inRepoAddon') {
    commandArgs.push('--in-repo-addon=my-addon');
  }
  options.command = command;
  options.package = mockPackage;
  options.projectRoot = projectRoot;
  options.packageName = getPackageName(projectRoot);

  if (command === 'generate' && options && (options.beforeGenerate || options.afterGenerate)) {
    beforeProcess = options.beforeGenerate;
    afterProcess = options.afterGenerate;
  } else if (command === 'destroy' && options && (options.beforeDestroy || options.afterDestroy)) {
    beforeProcess = options.beforeDestroy;
    afterProcess = options.afterDestroy;
  }
  return initProject(options)
    .then(resultContents.bind(null, options, tmpenv))
    .then(beforeProcess)
    .then(function() {
      return ember(commandArgs, cliOptions);
    })
    .then(resultContents.bind(null, options, tmpenv), throwResult.bind(null, options))
    .then(afterProcess)
    .then(teardownProject.bind(null, options))
    .catch(function(err) {
      throw err;
    });
}

/**
  Normalize and return object with result contents to use for assertions
  @function resultContents
  @param {Object} [options]
  @param {String} [options.command]
  @param {RegExp|Object} [options.throws]
  @param {Object} [env]
  @param {Path} [env.tmpdir]
  @param {Object} [result]
  @param {String} [result.statusCode]
  @param {Array} [result.errorLog]
  @return {Object}
*/
function resultContents(options, env, result) {
  debug('After ' + options.command + ' project contents: ', walkSync(env.tmpdir));
  // if throws is defined, and there is an result.error
  if (options && options.throws && result && result.statusCode) {
    // if the result has a SilentError, throw so we can assert
    if (result.errorLog.length) {
      throw result.errorLog[0];
    }
  }
  return {
    result: result,
    options: options,
    outputPath: env && env.tmpdir || null,
    outputFiles: env && env.tmpdir && walkSync(env.tmpdir) || null
  };
}

/**
  Rejection handler to extract error from results object and rethrow
  Also asserts the result error type before rethrow
  @function throwResult
  @param {Object} [options]
  @param {Object|String|RegExp} [options.throws]
  @param {Object} [err] result received by reject promise
  @throws {Error}
*/
function throwResult(options, err) {
  if (options && options.throws && err && err.statusCode) {
    if (err.errorLog && err.errorLog.length) {
      // assert the error type if we've defined one to check
      if (options.throws.type) {
        expect(err.errorLog[0].name).to.equal(options.throws.type);
      }
      throw err.errorLog[0];
    }
  }
  throw err;
}

/**
  Process assertions from hook
  @function processAssertions
  @param {Array} [assertions]
  @return {null}
*/
function processAssertions(assertions) {
  assertions.forEach(function(assertion) {
    expect(assertion()).to.be.true;
  });
}

/**
  Assert generated contents
  @function assertGenerated
  @param {Array} [files]
  @return {Chai.Assertion}
*/
function assertGenerated(files) {
  files.forEach(function(file) {
    if (typeof file.exists === 'undefined' || file.exists) {
      return assertFile(file.file, file);
    } else {
      return assertFileToNotExist(file.file);
    }
  });
}

/**
  Assert destroyed files
  @function assertDestroyed
  @param {Array} [files]
  @return {Chai.Assertion}
*/
function assertDestroyed(files) {
  files.forEach(function(file) {
    return assertFileToNotExist(file.file);
  });
}

/**
  Assert specific error is thrown.
  @function assertThrows
  @param {Promise} [promise] promise to assert
  @param {RegExp|Object} [assertion] message or error to match
  @param {Object} [err] error to assert
  @return {Chai.Assertion}
*/
function assertThrows(promise, options, assertion) {
  var message;
  if (assertion instanceof RegExp) {
    message = assertion;
  } else if (assertion.message) {
    if (assertion.message instanceof RegExp){
      message = assertion.message;
    } else {
      message = new RegExp(assertion.message);
    }
  } else {
    message = new RegExp(assertion);
  }
  return expect(promise).to.be.rejectedWith(message);
}
/**
  Get package from fixtures of type defined
  @function getPackage
  @param {Path} [pathRoot] root of project
  @param {String} [type] type of package 'app' or 'addon'
  @return {Object}
*/
function getPackage(pathRoot, type) {
  return path.resolve(pathRoot, 'node-tests', 'fixtures', type, 'package');
}

/**
  Get project root path using tmp
  @function getProjectRoot
  @param {String} [pathRoot]
  @return {Path}
*/
function getProjectRoot(pathRoot) {
  var tmp = process.cwd();
  try {
    tmp = findup.sync(pathRoot, 'tmp');
  } catch(e) {
    console.error(e);
  }
  return tmp;
}

/**
  Get package name from package.json
  @function getPackageName
  @param {Path} [projectRoot]
  @return {String}
*/
function getPackageName(projectRoot) {
  var contents = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), {encoding: 'utf8'}));
  return contents.name;
}

module.exports = {
  generate: generate,
  destroy: destroy,
  generateAndDestroy: generateAndDestroy,
  getPackage: getPackage,
  getPackageName: getPackageName,
  getProjectRoot: getProjectRoot,
  assertFileNotExists: assertFileToNotExist,
  assertThrows: assertThrows
};
