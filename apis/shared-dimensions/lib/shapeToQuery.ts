import onetime from 'onetime'
import { md } from '@cube-creator/core/namespace'
import { AnyPointer, GraphPointer } from 'clownface'
import { isGraphPointer } from 'is-graph-pointer'
import { hydra, sh } from '@tpluscode/rdf-ns-builders'
import { Parameters, PropertyShape } from '@hydrofoil/shape-to-query/model/constraint/ConstraintComponent'
import evalTemplateLiteral from 'rdf-loader-code/evalTemplateLiteral.js'
import namespace from '@rdfjs/namespace'
import { sparql } from '@tpluscode/sparql-builder'
import $rdf from 'rdf-ext'
import type { Literal } from '@rdfjs/types'
import env from './env'

/*
 The @hydrofoil/shape-to-query is an ES Module and as long as we compile to CJS, it needs to be loaded dynamically
 using this ugly TS hack
 */
// eslint-disable-next-line no-new-func
const _importDynamic = new Function('modulePath', 'return import(modulePath)')

export default async function shapeToQuery(): Promise<Pick<typeof import('@hydrofoil/shape-to-query'), 'constructQuery' | 'deleteQuery' | 's2q'>> {
  await setup()

  const { constructQuery, deleteQuery, s2q } = await _importDynamic('@hydrofoil/shape-to-query')

  return {
    constructQuery,
    deleteQuery,
    s2q,
  }
}

export async function rewriteTemplates(shape: AnyPointer, variables: Map<string, unknown>) {
  const { s2q } = await shapeToQuery()

  shape.any().has(s2q('template' as any))
    .forEach(templateNode => {
      const template = templateNode.out(s2q('template' as any))
      if (!isGraphPointer(template)) {
        throw new Error('Template not found')
      }

      const value = evalTemplateLiteral(template.value, { variables })
      const literalOption = (template.term as Literal).language || (template.term as Literal).datatype

      ;[...shape.dataset.match(null, null, templateNode.term)].forEach(quad => {
        shape.dataset.delete(quad)
        shape.dataset.add($rdf.quad(quad.subject, quad.predicate, $rdf.literal(value, literalOption), quad.graph))
      })

      templateNode.deleteOut()
    })

  shape.any().has(s2q('variable' as any))
    .forEach(templateNode => {
      const variableName = templateNode.out(s2q('variable' as any)).value
      if (!variableName) {
        return
      }

      const value: any = variables.get(variableName) || templateNode.out(sh.defaultValue).term

      ;[...shape.dataset.match(null, null, templateNode.term)].forEach(quad => {
        shape.dataset.delete(quad)
        if (value) {
          shape.dataset.add($rdf.quad(quad.subject, quad.predicate, value, quad.graph))
        }
      })

      templateNode.deleteOut()
    })
}

const setup = onetime(async () => {
  await defineConstraintComponents()
})

async function defineConstraintComponents() {
  const { default: ConstraintComponent } = await _importDynamic('@hydrofoil/shape-to-query/model/constraint/ConstraintComponent.js')
  const { constraintComponents } = await _importDynamic('@hydrofoil/shape-to-query/model/constraint/index.js')
  const { PatternConstraintComponent } = await _importDynamic('@hydrofoil/shape-to-query/model/constraint/pattern.js')

  constraintComponents.set(md.FreeTextSearchConstraintComponent, class TextSearch extends ConstraintComponent {
    static match(pointer: GraphPointer) {
      return isGraphPointer(pointer.out(hydra.freetextQuery))
    }

    static * fromShape(shape: PropertyShape) {
      const pattern = shape.get(hydra.freetextQuery) || []

      for (const patternElement of pattern) {
        if (!('pointer' in patternElement)) {
          continue
        }

        switch (env.maybe.MANAGED_DIMENSIONS_STORE_ENGINE) {
          case 'stardog':
            yield new TextSearch('stardog', patternElement.pointer.value)
            break
          case 'fuseki':
            yield new TextSearch('fuseki', patternElement.pointer.value)
            break
          default:
            yield new PatternConstraintComponent('^' + patternElement.pointer.value)
        }
      }
    }

    constructor(private readonly vendor: 'stardog' | 'fuseki', private readonly pattern: string) {
      super(md.FreeTextSearchConstraintComponent)
    }

    buildPatterns({ focusNode, valueNode, propertyPath }: Parameters): any {
      if (this.vendor === 'stardog') {
        const fts = namespace('tag:stardog:api:search:')
        return sparql`
        service ${fts.textMatch} {
          [] ${fts.query} """${this.pattern + '*'}""";
             ${fts.result} ${valueNode} ;
        }
        ${focusNode} ${propertyPath} ${valueNode} .
      `
      }

      if (this.vendor === 'fuseki') {
        return sparql`
        ${focusNode} <http://jena.apache.org/text#query> (${propertyPath} """${this.pattern + '*'}""") .

        # Second filtering to make sure the word starts with the given query
        ${focusNode} ${propertyPath} ${valueNode} .
        FILTER (REGEX(${valueNode}, "^${this.pattern}", "i"))
      `
      }

      throw new Error('Unsupported vendor')
    }
  })
}
