import { describe, expect, it } from 'vitest'
import { splitStatements } from './sql-split'

describe('splitStatements', () => {
  it('splits on top-level semicolons and drops comment-only pieces', () => {
    expect(
      splitStatements(`-- a header
create table a (id int);
/* between */
create index a_id on a (id);
-- trailing comment only
`),
    ).toEqual(['create table a (id int)', 'create index a_id on a (id)'])
  })

  it('keeps a semicolon inside strings, identifiers, dollar quotes and comments', () => {
    const fn = `create function f() returns text language sql as $body$ select 'x;y' $body$`
    expect(
      splitStatements(`insert into t values ('a;b', 'it''s;', E'c\\';d');
create table "odd;name" (id int /* ; */);
${fn};
select 1 -- ; not a split
;`),
    ).toEqual([
      `insert into t values ('a;b', 'it''s;', E'c\\';d')`,
      'create table "odd;name" (id int /* ; */)',
      fn,
      'select 1 -- ; not a split',
    ])
  })

  it('returns the last statement without a closing semicolon, and nothing for an empty file', () => {
    expect(splitStatements('select 1;\nselect 2\n')).toEqual([
      'select 1',
      'select 2',
    ])
    expect(splitStatements('  \n-- nothing\n')).toEqual([])
  })
})
