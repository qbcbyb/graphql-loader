import gql from "graphql-tag";
import { print as graphqlPrint } from "graphql/language/printer";
import { parse as graphqlParse } from "graphql/language/parser";
import { validate as graphqlValidate } from "graphql/validation/validate";

import { loader } from "webpack";
import {
  DocumentNode,
  DefinitionNode,
  GraphQLSchema,
  IntrospectionQuery,
  buildClientSchema,
  graphql,
} from "graphql";
import * as fs from "fs";
import pify = require("pify");
import * as loaderUtils from "loader-utils";

const fsReadFile = pify(fs.readFile);
async function readFile(filePath: string): Promise<string> {
  const content = await fsReadFile(filePath);
  return content.toString();
}

async function extractImports(
  loader: loader.LoaderContext,
  source: string,
  document: DocumentNode,
) {
  const lines = source.split(/(\r\n|\r|\n)/);
  const loaderResolve = pify(loader.resolve);

  const imports: Array<Promise<string>> = [];
  lines.forEach(line => {
    // Find lines that match syntax with `#import "<file>"`
    if (line[0] !== "#") {
      return;
    }

    const comment = line.slice(1).split(" ");
    if (comment[0] !== "import") {
      return;
    }

    const filePathMatch = comment[1] && comment[1].match(/^[\"\'](.+)[\"\']/);
    if (!filePathMatch || !filePathMatch.length) {
      throw new Error("#import statement must specify a quoted file path");
    }

    const filePath = filePathMatch[1];
    imports.push(
      new Promise((resolve, reject) => {
        loader.resolve(loader.context, filePath, (err, result) => {
          if (err) {
            reject(err);
          } else {
            loader.addDependency(result);
            resolve(result);
          }
        });
      }),
    );
  });

  const files = await Promise.all(imports);
  const contents = await Promise.all(files.map(doc => readFile(doc)));

  const nodes = await Promise.all(
    contents.map(content => loadSource(loader, content)),
  );

  const fragmentDefinitions = nodes.reduce((defs, node) => {
    defs.push(...node.definitions);
    return defs;
  }, [] as DefinitionNode[]);

  document.definitions = [...document.definitions, ...fragmentDefinitions];
  return document;
}

async function loadSource(loader: loader.LoaderContext, source: string) {
  let document: DocumentNode = gql(source);
  document = await extractImports(loader, source, document);
  return document;
}

function removeDuplicateFragments(document: DocumentNode) {
  const usedName = new Set();
  document.definitions = document.definitions.filter(def => {
    if (def.kind !== "FragmentDefinition") {
      return true;
    }

    const name = def.name.value;
    if (usedName.has(name)) {
      return false;
    } else {
      usedName.add(name);
      return true;
    }
  });
}

export default async function loader(
  this: loader.LoaderContext,
  source: string,
) {
  this.cacheable();
  const done = this.async();
  if (!done) {
    throw new Error("Loader does not support synchronous processing");
  }

  const options = { ...loaderUtils.getOptions(this) };
  let schema: GraphQLSchema | undefined = undefined;
  if (options.validate) {
    // XXX: add a test
    if (!options.schema) {
      this.emitError(
        new Error("schema option must be passed if validate is true") as any,
      );
      return;
    }

    const loaderResolve = pify(this.resolve);
    const schemaPath = await loaderResolve(this.context, options.schema);
    this.addDependency(schemaPath);
    const schemaString = await readFile(schemaPath);
    schema = buildClientSchema(JSON.parse(schemaString) as IntrospectionQuery);
  }

  let validationErrors: Error[] = [];
  try {
    const document = await loadSource(this, source);
    removeDuplicateFragments(document);

    if (schema) {
      // Validate
      validationErrors = graphqlValidate(schema, document);
      if (validationErrors.length > 0) {
        validationErrors.forEach(err => this.emitError(err as any));
      }
    }

    done(null, "module.exports = " + JSON.stringify(document));
  } catch (err) {
    done(err);
  }
}
