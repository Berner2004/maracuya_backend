const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgriculturalManagementService } = require('../dist/src/agricultural-management');
const { ExperimentalManagementService } = require('../dist/src/experimental-management');
const { PlantsManagementService } = require('../dist/src/plants-management');

const project = '00000000-0000-4000-8000-000000000001';
const lot = '00000000-0000-4000-8000-000000000002';
const plot = '00000000-0000-4000-8000-000000000003';
const row = '00000000-0000-4000-8000-000000000004';
const pos = '00000000-0000-4000-8000-000000000005';
const user = '00000000-0000-4000-8000-000000000006';
const unit = '00000000-0000-4000-8000-000000000007';
const treatment = '00000000-0000-4000-8000-000000000008';
const material = '00000000-0000-4000-8000-000000000009';

const fakeDb = (handler) => ({
  apiAs: async (_user, task) => task({ query: handler }),
});

test('Lot creation succeeds with valid payload', async () => {
  const service = new AgriculturalManagementService(
    fakeDb(async (sql, args) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      if (sql.includes('INSERT INTO public.lotes')) {
        return {
          rows: [{ id: lot, proyecto_id: project, codigo: args[1], nombre: args[2] }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  );
  const result = await service.createLot(user, project, {
    codigo: 'LOTE-01',
    nombre: 'Lote Principal',
    distancia_filas_m: 2.5,
    distancia_plantas_m: 2.0,
  });
  assert.equal(result.codigo, 'LOTE-01');
  assert.equal(result.nombre, 'Lote Principal');
});

test('Lot creation rejects duplicate code with 409', async () => {
  const service = new AgriculturalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      const err = new Error('duplicate key');
      err.code = '23505';
      throw err;
    }),
  );
  await assert.rejects(
    service.createLot(user, project, { codigo: 'LOTE-01', nombre: 'Lote Repetido' }),
    (e) => e.getStatus() === 409,
  );
});

test('Investigator cannot create lot (403)', async () => {
  const service = new AgriculturalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'investigador' }], rowCount: 1 };
      return { rows: [] };
    }),
  );
  await assert.rejects(
    service.createLot(user, project, { codigo: 'LOTE-X', nombre: 'Sin Permiso' }),
    (e) => e.getStatus() === 403,
  );
});

test('Investigator cannot modify an existing lot (403)', async () => {
  let updated = false;
  const service = new AgriculturalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'investigador' }], rowCount: 1 };
      if (sql.includes('UPDATE public.lotes')) updated = true;
      return { rows: [] };
    }),
  );
  await assert.rejects(
    service.updateLot(user, project, lot, { nombre: 'Cambio no autorizado' }),
    (e) => e.getStatus() === 403,
  );
  assert.equal(updated, false);
});

test('Positions batch creation succeeds and generates range', async () => {
  let insertedCount = 0;
  const service = new AgriculturalManagementService(
    fakeDb(async (sql, args) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.filas_cultivo')) return { rows: [{ id: row }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.posiciones_croquis')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO public.posiciones_croquis')) {
        insertedCount = (args.length - 2) / 2;
        return {
          rows: Array.from({ length: insertedCount }, (_, i) => ({
            id: `pos-${i + 1}`,
            fila_id: row,
            numero: i + 1,
            codigo_croquis: `F1-P${i + 1}`,
          })),
        };
      }
      return { rows: [] };
    }),
  );
  const result = await service.createPositionsBatch(user, project, {
    fila_id: row,
    desde_numero: 1,
    hasta_numero: 5,
    prefijo_croquis: 'F1-P',
  });
  assert.equal(result.length, 5);
  assert.equal(insertedCount, 5);
});

test('Positions batch rejects an existing number before inserting the range', async () => {
  let inserted = false;
  const service = new AgriculturalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.filas_cultivo')) return { rows: [{ id: row }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.posiciones_croquis')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO public.posiciones_croquis')) inserted = true;
      return { rows: [] };
    }),
  );
  await assert.rejects(
    service.createPositionsBatch(user, project, {
      fila_id: row,
      desde_numero: 1,
      hasta_numero: 5,
      prefijo_croquis: 'F1-P',
    }),
    (e) => e.getStatus() === 409,
  );
  assert.equal(inserted, false);
});

test('Positions batch rejects invalid range where hasta < desde', () => {
  const service = new AgriculturalManagementService(
    fakeDb(() => {
      throw new Error('should not execute');
    }),
  );
  assert.throws(
    () =>
      service.createPositionsBatch(user, project, {
        fila_id: row,
        desde_numero: 10,
        hasta_numero: 5,
      }),
    (e) => e.getStatus() === 400,
  );
});

test('Plot creation rejects missing lot with 404', async () => {
  const service = new AgriculturalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.lotes')) return { rows: [], rowCount: 0 };
      return { rows: [] };
    }),
  );
  await assert.rejects(
    service.createPlot(user, project, { lote_id: lot, codigo: 'PARC-01' }),
    (e) => e.getStatus() === 404,
  );
});

test('Administrator creates plot, row and position through existing contracts', async () => {
  const service = new AgriculturalManagementService(
    fakeDb(async (sql, args) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.lotes')) return { rows: [{ 1: 1 }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.parcelas')) return { rows: [{ id: plot }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.filas_cultivo')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id FROM public.filas_cultivo')) return { rows: [{ id: row }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.posiciones_croquis')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO public.parcelas')) {
        return { rows: [{ id: plot, lote_id: args[1], codigo: args[2] }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.filas_cultivo')) {
        return { rows: [{ id: row, parcela_id: args[1], numero: args[2] }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.posiciones_croquis')) {
        return { rows: [{ id: pos, fila_id: args[1], numero: args[2] }], rowCount: 1 };
      }
      return { rows: [] };
    }),
  );
  const createdPlot = await service.createPlot(user, project, {
    lote_id: lot,
    codigo: 'PARC-01',
  });
  const createdRow = await service.createRow(user, project, {
    parcela_id: createdPlot.id,
    numero: 1,
  });
  const createdPosition = await service.createPosition(user, project, {
    fila_id: createdRow.id,
    numero: 1,
  });
  assert.equal(createdPosition.fila_id, row);
});

test('Duplicate row number is rejected before insertion', async () => {
  let inserted = false;
  const service = new AgriculturalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.parcelas')) return { rows: [{ id: plot }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.filas_cultivo')) return { rows: [{ 1: 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO public.filas_cultivo')) inserted = true;
      return { rows: [] };
    }),
  );
  await assert.rejects(
    service.createRow(user, project, { parcela_id: plot, numero: 1 }),
    (e) => e.getStatus() === 409,
  );
  assert.equal(inserted, false);
});

test('Duplicate individual position number or croquis code is rejected', async () => {
  let inserted = false;
  const service = new AgriculturalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ role: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.filas_cultivo')) return { rows: [{ id: row }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.posiciones_croquis')) return { rows: [{ 1: 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO public.posiciones_croquis')) inserted = true;
      return { rows: [] };
    }),
  );
  await assert.rejects(
    service.createPosition(user, project, {
      fila_id: row,
      numero: 1,
      codigo_croquis: 'F1-P1',
    }),
    (e) => e.getStatus() === 409,
  );
  assert.equal(inserted, false);
});

test('Experimental unit creation validates parcel and treatment existence', async () => {
  const service = new ExperimentalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ rol: 'administrador' }], rowCount: 1 };
      if (sql.includes('EXISTS')) {
        return { rows: [{ parcela: true, tratamiento: true }], rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM public.unidades_experimentales')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO public.unidades_experimentales')) {
        return {
          rows: [{ id: unit, proyecto_id: project, parcela_id: plot, tratamiento_id: treatment, codigo: 'UE-01' }],
          rowCount: 1,
        };
      }
      return { rows: [] };
    }),
  );
  const result = await service.createUnit(user, project, {
    parcela_id: plot,
    tratamiento_id: treatment,
    codigo: 'UE-01',
    repeticion: 'R1',
  });
  assert.equal(result.codigo, 'UE-01');
});

test('Plant creation rejects experimental unit belonging to another parcel', async () => {
  const service = new PlantsManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ rol: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT f.id FROM public.filas_cultivo')) return { rows: [{ id: row }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.posiciones_croquis')) return { rows: [{ id: pos }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.plantas WHERE') && sql.includes('estado=\'activa\'')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT 1 FROM public.unidades_experimentales WHERE id=$1 AND proyecto_id=$2')) {
        return { rows: [{ 1: 1 }], rowCount: 1 };
      }
      if (sql.includes('FROM public.unidades_experimentales ue')) {
        // unit parcel mismatch
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  );
  await assert.rejects(
    service.create(user, project, {
      posicion_id: pos,
      codigo: 'PL-001',
      tipo_propagacion: 'pie_franco',
      unidad_experimental_id: unit,
    }),
    (e) => e.getStatus() === 400 && e.message.includes('parcela'),
  );
});

test('Administrator registers a plant in an available position', async () => {
  const service = new PlantsManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ rol: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT f.id FROM public.filas_cultivo')) return { rows: [{ id: row }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.posiciones_croquis')) return { rows: [{ id: pos }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.plantas') && sql.includes("estado='activa'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO public.plantas')) {
        return { rows: [{ id: '00000000-0000-4000-8000-000000000010', codigo: 'PL-001', posicion_id: pos }], rowCount: 1 };
      }
      return { rows: [] };
    }),
  );
  const result = await service.create(user, project, {
    posicion_id: pos,
    codigo: 'PL-001',
    tipo_propagacion: 'pie_franco',
  });
  assert.equal(result.codigo, 'PL-001');
  assert.equal(result.posicion_id, pos);
});

test('Plant creation rejects an occupied position before inserting', async () => {
  let inserted = false;
  const service = new PlantsManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ rol: 'administrador' }], rowCount: 1 };
      if (sql.includes('SELECT f.id FROM public.filas_cultivo')) return { rows: [{ id: row }], rowCount: 1 };
      if (sql.includes('SELECT id FROM public.posiciones_croquis')) return { rows: [{ id: pos }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM public.plantas') && sql.includes("estado='activa'")) {
        return { rows: [{ id: 'active' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.plantas')) inserted = true;
      return { rows: [] };
    }),
  );
  await assert.rejects(
    service.create(user, project, {
      posicion_id: pos,
      codigo: 'PL-002',
      tipo_propagacion: 'pie_franco',
    }),
    (e) => e.getStatus() === 409,
  );
  assert.equal(inserted, false);
});

test('Investigator cannot create plants (403)', async () => {
  const service = new PlantsManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ rol: 'investigador' }], rowCount: 1 };
      throw new Error('No plant write should run');
    }),
  );
  await assert.rejects(
    service.create(user, project, {
      posicion_id: pos,
      codigo: 'PL-002',
      tipo_propagacion: 'pie_franco',
    }),
    (e) => e.getStatus() === 403,
  );
});

test('Investigator cannot create experimental units (403)', async () => {
  const service = new ExperimentalManagementService(
    fakeDb(async (sql) => {
      if (sql.includes('SELECT rol')) return { rows: [{ rol: 'investigador' }], rowCount: 1 };
      throw new Error('No experimental write should run');
    }),
  );
  await assert.rejects(
    service.createUnit(user, project, {
      parcela_id: plot,
      tratamiento_id: treatment,
      codigo: 'UE-02',
    }),
    (e) => e.getStatus() === 403,
  );
});
const { MeasurementsManagementService } = require('../dist/src/measurements-management');
const creator = '00000000-0000-4000-8000-000000000088';
const capture = '00000000-0000-4000-8000-000000000089';

test('Measurement history resolves original creator name through an RLS-scoped LEFT JOIN', async () => {
  let readQuery;
  const service = new MeasurementsManagementService(fakeDb(async (sql, args) => {
    if (sql.includes('SELECT rol')) return { rows: [{ rol: 'consulta' }] };
    if (sql.includes('SELECT estado')) return { rows: [{ estado: 'activa' }] };
    readQuery = sql;
    assert.deepEqual(args, [project, pos]);
    return { rows: [{ id: capture, capturado_por: creator, capturado_por_nombre: 'Investigadora Original' }] };
  }));
  const result = await service.list(user, project, pos);
  assert.notEqual(user, creator);
  assert.equal(result[0].capturado_por, creator);
  assert.equal(result[0].capturado_por_nombre, 'Investigadora Original');
  assert.match(readQuery, /LEFT JOIN public.usuarios u ON u.id=m.capturado_por/);
  assert.match(readQuery, /u.nombre AS capturado_por_nombre/);
  assert.doesNotMatch(readQuery, /u\.correo|u\.superadmin|u\.\*/);
});

test('Measurement history preserves creator UUID when the user relation is unavailable', async () => {
  const service = new MeasurementsManagementService(fakeDb(async sql => {
    if (sql.includes('SELECT rol')) return { rows: [{ rol: 'investigador' }] };
    if (sql.includes('SELECT estado')) return { rows: [{ estado: 'activa' }] };
    return { rows: [{ id: capture, capturado_por: creator, capturado_por_nombre: null }] };
  }));
  assert.deepEqual(await service.list(user, project, pos), [{ id: capture, capturado_por: creator, capturado_por_nombre: null }]);
});

test('Measurement creator is taken from authenticated identity and UTC precision is unchanged', async () => {
  let insert;
  const date = '2026-01-01T14:29:23.006Z';
  const service = new MeasurementsManagementService(fakeDb(async (sql, args) => {
    if (sql.includes('SELECT rol')) return { rows: [{ rol: 'tecnico_campo' }] };
    if (sql.includes('SELECT estado')) return { rows: [{ estado: 'activa' }] };
    if (sql.includes('INSERT INTO public.mediciones_campo')) { insert = args; return { rows: [{ id: capture }] }; }
    return { rows: [] };
  }));
  const payload = { cliente_registro_id: capture, fecha_medicion: date, altura_cm: 0 };
  assert.throws(() => service.create(user, project, pos, { ...payload, capturado_por: creator }), e => e.getStatus() === 400);
  await service.create(user, project, pos, payload);
  assert.equal(insert[2], user);
  assert.equal(insert[3], date);
  assert.equal(insert[4], 0);
});

