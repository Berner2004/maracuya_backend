const {test}=require('node:test');
const assert=require('node:assert/strict');
const {witnessStatus,naturalWitness,validateWitness,RowControlsService}=require('../dist/src/row-controls');
const {PlantsManagementService}=require('../dist/src/plants-management');
const project='00000000-0000-4000-8000-000000000001';
const plant='00000000-0000-4000-8000-000000000002';
const row='00000000-0000-4000-8000-000000000003';
const pos='00000000-0000-4000-8000-000000000004';
const user='00000000-0000-4000-8000-000000000005';
const witness={id:plant,es_testigo:true,estado:'activa',tipo_propagacion:'pie_franco',portainjerto_id:null,unidad_experimental_id:null};
test('es_control treatment never implies es_testigo',()=>{
  assert.equal(witnessStatus([{...witness,es_testigo:false,es_control:true}]).estado,'pendiente');
});
test('One active natural witness is assigned; historical witnesses do not duplicate',()=>{
  assert.equal(witnessStatus([witness,{...witness,id:'old',estado:'reemplazada'}]).estado,'asignado');
});
test('Active duplicates are reported without selecting one',()=>{
  const status=witnessStatus([witness,{...witness,id:'other'}]);
  assert.equal(status.estado,'duplicado');assert.equal(status.testigo_id,null);
});
test('Grafted, rootstock, unit and previously intervened witnesses are incompatible',()=>{
  for(const patch of [{tipo_propagacion:'injertada'},{portainjerto_id:'root'},{unidad_experimental_id:'unit'},{intervenida:true}]){
    assert.equal(naturalWitness({...witness,...patch}),false);
    assert.equal(witnessStatus([{...witness,...patch}]).estado,'incompatible');
  }
});
test('Row validation locks actual relationship and rejects a duplicate',async()=>{
  const calls=[];const tx={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('actividades_agricolas'))return {rows:[],rowCount:0};
    if(sql.includes('SELECT p.id'))return {rows:[{id:plant}],rowCount:1};
    return {rows:[{id:row}],rowCount:1};
  }};
  await assert.rejects(validateWitness(tx,project,pos,witness),/ya tiene/);
  assert.match(calls[0].sql,/pc.fila_id=f.id/);assert.match(calls[0].sql,/FOR UPDATE OF f/);
  assert.match(calls[1].sql,/actividades_agricolas/);
  assert.equal(calls[2].args[1],row);
});
test('Intervened plant cannot be assigned as a natural witness',async()=>{
  const tx={query:async(sql)=>{
    if(sql.includes('actividades_agricolas'))return {rows:[{1:1}],rowCount:1};
    return {rows:[{id:row}],rowCount:1};
  }};
  await assert.rejects(
    validateWitness(tx,project,pos,witness,plant,plant),
    e=>e.getStatus()===400&&e.message.includes('intervención'),
  );
});
const fakeDb=handler=>({apiAs:async(_user,task)=>task({query:handler})});
test('Investigator cannot assign a witness',async()=>{
  const s=new RowControlsService(fakeDb(async()=>({rows:[{rol:'investigador'}],rowCount:1})));
  await assert.rejects(s.assign(user,project,row,{planta_id:plant,croquis_referencia:'Original A1',verificado:true}),e=>e.getStatus()===403);
});
test('Unverified croquis is rejected before accessing the database',()=>{
  const s=new RowControlsService(fakeDb(()=>{throw Error('should not query');}));
  assert.throws(()=>s.assign(user,project,row,{planta_id:plant,croquis_referencia:'Original A1',verificado:false}),e=>e.getStatus()===400);
});
test('A plant outside requested row cannot be assigned',async()=>{
  const s=new RowControlsService(fakeDb(async sql=>{
    if(sql.includes('SELECT rol'))return {rows:[{rol:'administrador'}],rowCount:1};
    if(sql.includes('pg_trigger'))return {rows:[{ok:true}],rowCount:1};
    if(sql.includes('SELECT id FROM public.filas_cultivo'))return {rows:[{id:row}],rowCount:1};
    return {rows:[],rowCount:0};
  }));
  await assert.rejects(s.assign(user,project,row,{planta_id:plant,croquis_referencia:'Original A1',verificado:true}),e=>e.getStatus()===404);
});
test('Comparison rejects missing or incompatible same-row witness',async()=>{
  const s=new RowControlsService(fakeDb(async sql=>sql.includes('SELECT rol')?{rows:[{rol:'consulta'}]}:{rows:[]}));
  await assert.rejects(s.comparison(user,project,row),e=>e.getStatus()===409);
});
test('Comparison query only includes current row witness and active experimental plants',async()=>{
  let queriedIds;
  const plants=[witness,{...witness,id:'treated',es_testigo:false,unidad_experimental_id:'unit'},
    {...witness,id:'unassigned',es_testigo:false}, {...witness,id:'retired',es_testigo:false,estado:'retirada',unidad_experimental_id:'unit'}];
  const s=new RowControlsService(fakeDb(async(sql,args)=>{
    if(sql.includes('SELECT rol'))return {rows:[{rol:'consulta'}]};
    if(sql.includes('row_number()')){queriedIds=args[1];return {rows:[]};}
    assert.equal(args[1],row);return {rows:plants};
  }));
  const result=await s.comparison(user,project,row);
  assert.deepEqual(queriedIds,[plant,'treated']);assert.equal(result.testigo_id,plant);
});
test('Replacing a witness requires an explicit continuity decision',async()=>{
  let writes=0;
  const s=new PlantsManagementService(fakeDb(async sql=>{
    if(sql.includes('SELECT rol'))return {rows:[{rol:'administrador'}]};
    if(sql.includes('pg_trigger'))return {rows:[{ok:true}]};
    if(sql.includes('SELECT posicion_id, estado, fecha_plantacion'))return {rows:[{...witness,posicion_id:pos,fecha_plantacion:null}]};
    writes++;throw Error('unexpected write');
  }));
  await assert.rejects(s.replace(user,project,plant,{codigo:'P-NEW',tipo_propagacion:'pie_franco',es_testigo:true,croquis_referencia:'Croquis A1',croquis_verificado:true}),e=>e.getStatus()===400);
  assert.equal(writes,0);
});
test('Experimental unit cannot be assigned to a natural witness',async()=>{
  const s=new PlantsManagementService(fakeDb(async sql=>sql.includes('SELECT rol')?{rows:[{rol:'administrador'}]}:{rows:[{...witness,posicion_id:pos}]}));
  await assert.rejects(s.assignUnit(user,project,plant,{unidad_experimental_id:row}),e=>e.getStatus()===400);
});
test('Creating a witness requires verified croquis before any insertion',async()=>{
  let writes=0;
  const s=new PlantsManagementService(fakeDb(async sql=>{
    if(sql.includes('SELECT rol'))return {rows:[{rol:'administrador'}]};
    if(sql.includes('pg_trigger'))return {rows:[{ok:true}]};
    writes++;throw Error('Unexpected write');
  }));
  await assert.rejects(s.create(user,project,{posicion_id:pos,codigo:'P-NEW',tipo_propagacion:'pie_franco',es_testigo:true}),e=>e.getStatus()===400);
  assert.equal(writes,0);
});
test('Creating a verified witness rejects an already occupied witness row',async()=>{
  let inserts=0;
  const s=new PlantsManagementService(fakeDb(async sql=>{
    if(sql.includes('SELECT rol'))return {rows:[{rol:'administrador'}]};
    if(sql.includes('pg_trigger'))return {rows:[{ok:true}]};
    if(sql.includes('actividades_agricolas'))return {rows:[],rowCount:0};
    if(sql.includes('SELECT p.id'))return {rows:[{id:plant}],rowCount:1};
    if(sql.includes('INSERT'))inserts++;
    return {rows:[{id:row}],rowCount:1};
  }));
  await assert.rejects(s.create(user,project,{posicion_id:pos,codigo:'P-NEW',tipo_propagacion:'pie_franco',es_testigo:true,croquis_verificado:true,croquis_referencia:'Original A1'}),e=>e.getStatus()===409);
  assert.equal(inserts,0);
});
const { Db } = require('../dist/src/db');
const { witnessSchemaReady, requireWitnessSchema } = require('../dist/src/row-controls');
const newPlant = '00000000-0000-4000-8000-000000000099';

function auditHarness({ alreadyWitness = false, failAudit = false, membership = 'administrador' } = {}) {
  const calls = [];
  const client = {
    release() { calls.push({ sql: 'RELEASE' }); },
    async query(sql, args) {
      calls.push({ sql, args });
      const result = (rows = []) => ({ rows, rowCount: rows.length });
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE)/.test(sql) || sql.includes('set_config')) return result();
      if (sql.includes('SELECT rol')) {
        assert.match(sql, /activo/);
        return result(membership ? [{ rol: membership }] : []);
      }
      if (sql.includes('pg_trigger')) return result([{ ok: true }]);
      if (sql.includes('SELECT posicion_id, estado, fecha_plantacion')) return result([{ ...witness, posicion_id: pos, fecha_plantacion: null }]);
      if (sql.includes('SELECT p.* FROM public.plantas')) return result([{ ...witness, es_testigo: alreadyWitness, posicion_id: pos }]);
      if (sql.includes('SELECT f.id FROM public.filas_cultivo')) return result([{ id: row }]);
      if (sql.includes('SELECT id FROM public.filas_cultivo')) return result([{ id: row }]);
      if (sql.includes('actividades_agricolas') || sql.includes('SELECT p.id')) return result();
      if (sql.includes('SELECT id FROM public.posiciones_croquis')) return result([{ id: pos }]);
      if (sql.includes('SELECT 1 FROM public.plantas')) return result();
      if (sql.includes('SELECT count(*)::text')) return result([{ count: '1' }]);
      if (sql.includes('SELECT observaciones')) return result([{ observaciones: 'Historial previo' }]);
      if (sql.includes('UPDATE public.plantas')) return result([{ id: plant }]);
      if (sql.includes('INSERT INTO public.plantas')) return result([{ id: newPlant, posicion_id: pos }]);
      if (sql.includes('INSERT INTO public.testigos_fila_eventos')) {
        if (failAudit) throw Object.assign(new Error('Invalid audit event'), { code: '23514' });
        return result([{ id: newPlant }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  // Use the actual transaction wrapper with a simulated PoolClient, without creating a Pool.
  const db = { apiAs: (id, operation) => Db.prototype.apiAs.call({ api: { connect: async () => client } }, id, operation) };
  return { db, calls };
}

for (const mode of ['create', 'assign', 'continue', 'pending']) {
  const run = (db) => {
    if (mode === 'assign') return new RowControlsService(db).assign(user, project, row, {
      planta_id: plant, croquis_referencia: 'Croquis original A1', verificado: true,
    });
    const payload = { codigo: 'NUEVA', tipo_propagacion: 'pie_franco', es_testigo: mode !== 'pending',
      croquis_referencia: 'Croquis original A1', croquis_verificado: true };
    if (mode === 'create') return new PlantsManagementService(db).create(user, project, { ...payload, posicion_id: pos });
    return new PlantsManagementService(db).replace(user, project, plant, {
      ...payload, continuidad_testigo: mode === 'continue' ? 'continuar' : 'pendiente',
    });
  };
  test(`${mode}: audit contract and mutation share one transaction before COMMIT`, async () => {
    const { db, calls } = auditHarness();
    await run(db);
    const audits = calls.filter(c => c.sql.includes('INSERT INTO public.testigos_fila_eventos'));
    assert.equal(audits.length, 1);
    assert.match(audits[0].sql, /proyecto_id,fila_id,/);
    assert.match(audits[0].sql, /accion,referencia,usuario_id/);
    const expected = mode === 'assign' ? [project, row, plant, 'Croquis original A1', user]
      : mode === 'create' ? [project, pos, newPlant, 'Croquis original A1', user]
      : [project, pos, plant, newPlant, mode === 'continue' ? 'continuar' : 'pendiente', 'Croquis original A1', user];
    assert.deepEqual(audits[0].args, expected);
    assert.equal(calls.filter(c => c.sql === 'BEGIN').length, 1);
    assert.equal(calls.filter(c => c.sql === 'COMMIT').length, 1);
    assert.ok(calls.indexOf(audits[0]) < calls.findIndex(c => c.sql === 'COMMIT'));
    assert.equal(calls.some(c => c.sql === 'ROLLBACK'), false);
    if (mode === 'continue' || mode === 'pending') {
      assert.ok(calls.some(c => c.sql.includes("estado='reemplazada'")));
      assert.equal(calls.some(c => /DELETE FROM public.plantas/.test(c.sql)), false);
    }
  });
  test(`${mode}: failed audit rolls back the mutation`, async () => {
    const { db, calls } = auditHarness({ failAudit: true });
    await assert.rejects(run(db), e => e.getStatus() === 400);
    assert.equal(calls.some(c => c.sql === 'COMMIT'), false);
    assert.equal(calls.some(c => c.sql === 'ROLLBACK'), true);
    assert.equal(calls.at(-1).sql, 'RELEASE');
  });
}

test('Repeating an existing verified assignment creates no duplicate audit event', async () => {
  const { db, calls } = auditHarness({ alreadyWitness: true });
  const result = await new RowControlsService(db).assign(user, project, row, {
    planta_id: plant, croquis_referencia: 'Croquis original A1', verificado: true,
  });
  assert.equal(result.es_testigo, true);
  assert.equal(calls.some(c => c.sql.includes('UPDATE public.plantas')), false);
  assert.equal(calls.some(c => c.sql.includes('INSERT INTO public.testigos_fila_eventos')), false);
});

test('Inactive administrator cannot assign or write an audit event', async () => {
  const { db, calls } = auditHarness({ membership: null });
  await assert.rejects(new RowControlsService(db).assign(user, project, row, {
    planta_id: plant, croquis_referencia: 'Croquis original A1', verificado: true,
  }), e => e.getStatus() === 404);
  assert.equal(calls.some(c => /INSERT|UPDATE/.test(c.sql)), false);
});

test('Field and write guard use the same integrity query without checking function EXECUTE', async () => {
  const queries = [];
  const handler = async (sql) => {
    if (sql.includes('SELECT rol')) return { rows: [{ rol: 'administrador' }] };
    if (sql.includes('pg_trigger')) { queries.push(sql); return { rows: [{ ok: true }] }; }
    return { rows: [] };
  };
  const field = await new RowControlsService(fakeDb(handler)).field(user, project);
  await requireWitnessSchema({ query: handler });
  assert.equal(field.integridad_testigos_activa, true);
  assert.equal(queries[0], queries[1]);
  assert.match(queries[0], /tgenabled IN \('O','A'\)/);
  assert.match(queries[0], /testigos_fila_guardia/);
  assert.match(queries[0], /testigos_fila_eventos/);
  assert.doesNotMatch(queries[0], /EXECUTE|has_function_privilege/i);
});

test('Incomplete integrity is reported consistently without assuming a missing migration', async () => {
  const tx = { query: async () => ({ rows: [{ ok: false }] }) };
  assert.equal(await witnessSchemaReady(tx), false);
  await assert.rejects(requireWitnessSchema(tx), e => e.getStatus() === 503 && !e.message.includes('aplicar'));
});

