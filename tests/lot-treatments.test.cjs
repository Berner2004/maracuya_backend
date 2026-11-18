const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ExperimentalManagementService, ExperimentalManagementController } = require('../dist/src/experimental-management');
const project='00000000-0000-4000-8000-000000000001';
const lot='00000000-0000-4000-8000-000000000002';
const treatment='00000000-0000-4000-8000-000000000003';
const plot='00000000-0000-4000-8000-000000000004';
const user='00000000-0000-4000-8000-000000000005';
const input={tratamiento_id:treatment,codigo_local:'t1',referencia_validacion:'Protocolo revisado por administrador'};
let oldFlag;
beforeEach(()=>{oldFlag=process.env.TRATAMIENTOS_LOTE_ACTIVO;process.env.TRATAMIENTOS_LOTE_ACTIVO='true';});
afterEach(()=>{if(oldFlag===undefined)delete process.env.TRATAMIENTOS_LOTE_ACTIVO;else process.env.TRATAMIENTOS_LOTE_ACTIVO=oldFlag;});
function harness({role='administrador',handler=async()=>({rows:[],rowCount:0})}={}) {
  const calls=[];
  const service=new ExperimentalManagementService({apiAs:async(identity,operation)=>{
    assert.equal(identity,user);
    return operation({query:async(sql,params)=>{
      calls.push({sql,params});
      if(sql.includes('SELECT rol')) return {rows:role?[{rol:role}]:[],rowCount:role?1:0};
      return handler(sql,params);
    }});
  }});
  return {service,calls};
}
const status=expected=>error=>error.getStatus()===expected;

test('catalog is disabled by default and does not query a missing table',async()=>{
  delete process.env.TRATAMIENTOS_LOTE_ACTIVO;
  const h=harness();
  await assert.rejects(h.service.listLotTreatments(user,project,lot),status(503));
  await assert.rejects(h.service.createLotTreatment(user,project,lot,input),status(503));
  assert.equal(h.calls.length,2); // memberships only
});

test('only an active project administrator can create a correspondence',async()=>{
  for(const role of ['investigador','consulta',null]) {
    const h=harness({role});
    await assert.rejects(h.service.createLotTreatment(user,project,lot,input),status(role?403:404));
    assert.equal(h.calls.length,1);
  }
});

test('controller requires the verified JWT identity',()=>{
  const controller=new ExperimentalManagementController({});
  assert.throws(()=>controller.createLotTreatment({},project,lot,input),status(403));
});

test('rejects invalid references and forged author, time or identifiers before querying',()=>{
  const h=harness();
  for(const extra of [{creado_por:user},{id:lot},{creado_en:'2026-01-01'},{proyecto_id:project}]) {
    assert.throws(()=>h.service.createLotTreatment(user,project,lot,{...input,...extra}),status(400));
  }
  assert.throws(()=>h.service.listLotTreatments(user,project,'invalid'),status(400));
  assert.equal(h.calls.length,0);
});

test('new correspondence checks both parents against the same project and leaves historic tables unchanged',async()=>{
  const h=harness({handler:async(sql,params)=>{
    if(sql.includes('EXISTS')) {
      assert.deepEqual(params,[project,lot,treatment]);
      return {rows:[{lote:true,tratamiento:true}]};
    }
    assert.match(sql,/INSERT INTO public\.tratamientos_lote/);
    assert.deepEqual(params,[project,lot,treatment,'t1',input.referencia_validacion]);
    const columns=sql.slice(sql.indexOf('('),sql.indexOf('VALUES'));
    assert.doesNotMatch(columns,/creado_por|creado_en|codigo_normalizado|\bid\b/);
    return {rows:[{id:'mapping',creado_por:user,...input}]};
  }});
  const result=await h.service.createLotTreatment(user,project,lot,input);
  assert.equal(result.creado_por,user);
  assert.equal(result.codigo_local,'t1');
  assert.equal(h.calls.filter(c=>/INSERT|UPDATE|DELETE/.test(c.sql)).length,1);
});

test('foreign-project lot or treatment is rejected without inserting',async()=>{
  for(const parents of [{lote:false,tratamiento:true},{lote:true,tratamiento:false}]) {
    const h=harness({handler:async()=>({rows:[parents]})});
    await assert.rejects(h.service.createLotTreatment(user,project,lot,input),status(404));
    assert.equal(h.calls.some(c=>c.sql.includes('INSERT')),false);
  }
});

test('database uniqueness handles concurrent and case-equivalent conflicts as 409',async()=>{
  const h=harness({handler:async(sql)=>{
    if(sql.includes('EXISTS')) return {rows:[{lote:true,tratamiento:true}]};
    throw Object.assign(new Error('internal details must stay private'),{code:'23505'});
  }});
  for(const code of ['T1','t1']) {
    await assert.rejects(h.service.createLotTreatment(user,project,lot,{...input,codigo_local:code}),error=>{
      assert.equal(error.getStatus(),409);
      assert.doesNotMatch(error.message,/internal details/);
      return true;
    });
  }
});

test('reader consults only the requested project and lot; absent lot is 404',async()=>{
  const h=harness({role:'investigador',handler:async(sql,params)=>{
    if(sql.startsWith('SELECT id')) return {rows:[{id:lot}],rowCount:1};
    assert.match(sql,/tl\.proyecto_id=\$1 AND tl\.lote_id=\$2/);
    assert.match(sql,/t\.id=tl\.tratamiento_id AND t\.proyecto_id=tl\.proyecto_id/);
    assert.deepEqual(params,[project,lot]);
    return {rows:[{id:'mapping',codigo_local:'T1'}]};
  }});
  assert.equal((await h.service.listLotTreatments(user,project,lot))[0].codigo_local,'T1');
  const absent=harness({handler:async()=>({rows:[],rowCount:0})});
  await assert.rejects(absent.service.listLotTreatments(user,project,lot),status(404));
});

test('new units require the reviewed treatment of the parcel lot when enabled',async()=>{
  const h=harness({handler:async(sql,params)=>{
    if(sql.includes('EXISTS')) return {rows:[{parcela:true,tratamiento:true}]};
    assert.match(sql,/JOIN public\.parcelas p ON p\.proyecto_id=tl\.proyecto_id AND p\.lote_id=tl\.lote_id/);
    assert.deepEqual(params,[project,plot,treatment]);
    return {rows:[],rowCount:0};
  }});
  await assert.rejects(h.service.createUnit(user,project,{parcela_id:plot,tratamiento_id:treatment,codigo:'UE-A'}),status(400));
  assert.equal(h.calls.some(c=>c.sql.includes('INSERT')),false);
});

test('matching correspondence permits new unit creation without creating or changing treatments',async()=>{
  const h=harness({handler:async(sql)=>{
    if(sql.includes('EXISTS')) return {rows:[{parcela:true,tratamiento:true}]};
    if(sql.includes('SELECT tl.id')) return {rows:[{id:'mapping'}],rowCount:1};
    if(sql.includes('SELECT id FROM public.unidades_experimentales')) return {rows:[],rowCount:0};
    assert.match(sql,/INSERT INTO public\.unidades_experimentales/);
    return {rows:[{id:'unit',tratamiento_id:treatment}]};
  }});
  const result=await h.service.createUnit(user,project,{parcela_id:plot,tratamiento_id:treatment,codigo:'UE-A'});
  assert.equal(result.tratamiento_id,treatment);
  assert.equal(h.calls.filter(c=>/INSERT|UPDATE|DELETE/.test(c.sql)).length,1);
});

test('historical units without reviewed mappings remain visible via LEFT JOIN',async()=>{
  const historical={id:'historical',tratamiento_lote_id:null,codigo_local:null,correspondencia_validada:false};
  const h=harness({role:'consulta',handler:async(sql)=>{
    assert.match(sql,/LEFT JOIN public\.tratamientos_lote/);
    assert.match(sql,/tl\.lote_id=p\.lote_id/);
    assert.doesNotMatch(sql,/WHERE[^]*tl\.id IS NOT NULL/);
    return {rows:[historical]};
  }});
  assert.deepEqual(await h.service.listUnits(user,project),[historical]);
  assert.equal(h.calls.some(c=>/UPDATE|INSERT|DELETE/.test(c.sql)),false);
});

test('disabled catalog preserves the existing unit query and creation contract',async()=>{
  process.env.TRATAMIENTOS_LOTE_ACTIVO='false';
  const h=harness({handler:async(sql)=>{
    assert.doesNotMatch(sql,/tratamientos_lote/);
    if(sql.includes('EXISTS')) return {rows:[{parcela:true,tratamiento:true}]};
    if(sql.includes('SELECT id FROM public.unidades_experimentales')) return {rows:[],rowCount:0};
    return {rows:[{id:'legacy'}]};
  }});
  assert.equal((await h.service.listUnits(user,project))[0].id,'legacy');
  assert.equal((await h.service.createUnit(user,project,{parcela_id:plot,tratamiento_id:treatment,codigo:'UE-A'})).id,'legacy');
});

test('enabled flag without migration fails clearly rather than bypassing validation',async()=>{
  const h=harness({handler:async(sql)=>{
    if(sql.startsWith('SELECT id')) return {rows:[{id:lot}],rowCount:1};
    throw Object.assign(new Error('missing relation'),{code:'42P01'});
  }});
  await assert.rejects(h.service.listLotTreatments(user,project,lot),status(503));
});

test('migration security contract: normalized uniqueness, restricted ownership/grants and protected rollback',()=>{
  const up=fs.readFileSync(path.join(__dirname,'../sql/03_tratamientos_lote.up.sql'),'utf8');
  const down=fs.readFileSync(path.join(__dirname,'../sql/03_tratamientos_lote.down.sql'),'utf8');
  assert.match(up,/codigo_normalizado text GENERATED ALWAYS AS \(lower\(codigo_local\)\) STORED/);
  assert.match(up,/UNIQUE \(proyecto_id, lote_id, codigo_normalizado\)/);
  assert.match(up,/OWNER TO postgres/);
  assert.match(up,/FORCE ROW LEVEL SECURITY/);
  assert.match(up,/aclexplode/); // Supabase default ACL must not leak grants.
  assert.doesNotMatch(up,/GRANT[^;]*\b(?:UPDATE|DELETE|TRUNCATE|ALL)\b/);
  assert.doesNotMatch(up,/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.(?:plantas|tratamientos|unidades_experimentales)\b/);
  assert.match(down,/row_security = off/);
  assert.match(down,/ACCESS EXCLUSIVE MODE/);
  assert.match(down,/IF EXISTS \(SELECT 1 FROM public\.tratamientos_lote\)/);
  assert.match(down,/DROP TABLE public\.tratamientos_lote RESTRICT/);
});
