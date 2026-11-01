import { MongoClient, type ClientSession, type Collection, type Db, type Document } from "mongodb";
import { getTableName, getTableColumns } from "drizzle-orm";

const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
if (!uri) throw new Error("MONGODB_URI must be set to your MongoDB Atlas connection string.");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
let dbPromise: Promise<Db> | undefined;
async function mongoDb(): Promise<Db> {
  if (!dbPromise) dbPromise = client.connect().then(async () => {
    const dbName = process.env.MONGODB_DB_NAME;
    const database = dbName ? client.db(dbName) : client.db();
    await Promise.all([
      database.collection("users").createIndex({ email: 1 }, { unique: true, sparse: true }),
      database.collection("users").createIndex({ username: 1 }, { unique: true, sparse: true }),
      database.collection("templates").createIndex({ slug: 1 }, { unique: true, sparse: true }),
      database.collection("payments").createIndex({ reference: 1 }, { unique: true, sparse: true }),
      database.collection("wallet_transactions").createIndex({ reference: 1 }, { unique: true, sparse: true }),
      database.collection("coin_transactions").createIndex({ reference: 1 }, { unique: true, sparse: true }),
      database.collection("settings").createIndex({ key: 1 }, { unique: true }),
    ]);
    return database;
  });
  return dbPromise;
}
export async function closeMongo(): Promise<void> { if (dbPromise) await client.close(); dbPromise = undefined; }

function tableName(table: any): string { return getTableName(table).replace(/-/g, "_"); }
function columns(table: any): Record<string, any> { return getTableColumns(table) as Record<string, any>; }
function field(column: any): { table: string; key: string } { const cols=columns(column.table); const entry=Object.entries(cols).find(([,c])=>c===column); return { table: tableName(column.table), key: entry?.[0] ?? column.name }; }
type Expr = { kind: string; args: any[] };
const expr = (kind: string, ...args: any[]): Expr => ({ kind, args });
export const eq = (a: any,b: any) => expr("eq",a,b);
export const ne = (a: any,b: any) => expr("ne",a,b);
export const and = (...args: any[]) => expr("and",...args.filter(Boolean));
export const or = (...args: any[]) => expr("or",...args.filter(Boolean));
export const gte = (a: any,b: any) => expr("gte",a,b);
export const lte = (a: any,b: any) => expr("lte",a,b);
export const gt = (a: any,b: any) => expr("gt",a,b);
export const lt = (a: any,b: any) => expr("lt",a,b);
export const isNull = (a: any) => expr("isNull",a);
export const isNotNull = (a: any) => expr("isNotNull",a);
export const inArray = (a: any,b: any[]) => expr("inArray",a,b);
export const ilike = (a: any,b: string) => expr("ilike",a,b);
export const desc = (a: any) => expr("desc",a);
export const asc = (a: any) => expr("asc",a);
export function sql<T = unknown>(strings: TemplateStringsArray, ...values: any[]): Expr {
  return expr("sql", strings, ...values);
}
function sqlText(e: Expr): string { const strings=e.args[0] as TemplateStringsArray; let out=""; for(let i=0;i<strings.length;i++){out+=strings[i]; if(i<e.args.length-1) out+=`§${i}§`; } return out; }
function rawValue(value:any, rows:Record<string,any>):any {
  if (value?.kind === "sql") {
    const txt=sqlText(value);
    const fieldMatch=txt.match(/lower\s*\(\s*trim\s*\(\s*§0§\s*\)\s*\)\s*=\s*§1§/i);
    if(fieldMatch) return String(rawValue(value.args[1],rows) ?? "").trim().toLowerCase() === String(value.args[2] ?? "").trim().toLowerCase();
    return value;
  }
  if(value && typeof value === "object" && typeof value.name === "string" && value.table) {
    const f=field(value); return rows[f.table]?.[f.key];
  }
  return value;
}
function matches(e:any, rows:Record<string,any>):boolean {
  if(!e) return true;
  if(e.kind === "and") return e.args.every((x:any)=>matches(x,rows));
  if(e.kind === "or") return e.args.some((x:any)=>matches(x,rows));
  if(e.kind === "sql") { const txt=sqlText(e); if(/lower\s*\(\s*trim/i.test(txt)) return rawValue(e,rows) === true; return true; }
  const [a,b]=e.args; const av=rawValue(a,rows); const bv=rawValue(b,rows);
  switch(e.kind){case "eq":return av===bv; case "ne":return av!==bv; case "gte":return av>=bv; case "lte":return av<=bv; case "gt":return av>bv; case "lt":return av<bv; case "isNull":return av==null; case "isNotNull":return av!=null; case "inArray":return (b as any[]).includes(av); case "ilike":{const pattern=String(b).replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/%/g,".*").replace(/_/g,".");return new RegExp(`^${pattern}$`,"i").test(String(av??""));} default:return true;}
}
function projection(selection:any, rows:Record<string,any>):any {
  if(!selection) return rows[Object.keys(rows)[0]];
  const out:any={};
  for(const [key,value] of Object.entries(selection)){
    if(value && typeof value === "object" && !value.name && !value.kind && !Array.isArray(value)) { const tn=tableName(value); out[key]=rows[tn] ?? null; }
    else if(value?.kind === "sql") { const txt=sqlText(value); if(/count\s*\(/i.test(txt)) out[key]=1; else out[key]=null; }
    else out[key]=rawValue(value,rows);
  }
  return out;
}
function updateValue(value:any, current:any, rows:Record<string,any>):any {
  if(value?.kind === "sql") {
    const txt=sqlText(value);
    if(/§0§\s*[-+]\s*§1§/.test(txt)) { const amount=Number(value.args[2] ?? 0); return /-/.test(txt) ? Number(current ?? 0)-amount : Number(current ?? 0)+amount; }
    return rawValue(value,rows);
  }
  return value;
}
class SelectQuery {
  private base:any; private joins:{table:any; predicate:any; left:boolean}[]=[]; private predicate:any; private orders:any[]=[]; private max:number|undefined; private groups:any[]=[];
  constructor(private selection:any, private session?:ClientSession){}
  from(t:any){this.base=t;return this;} leftJoin(t:any,p:any){this.joins.push({table:t,predicate:p,left:true});return this;} innerJoin(t:any,p:any){this.joins.push({table:t,predicate:p,left:false});return this;} where(p:any){this.predicate=p;return this;} orderBy(...o:any[]){this.orders=o;return this;} limit(n:number){this.max=n;return this;} groupBy(...g:any[]){this.groups=g;return this;} $dynamic(){return this;}
  async run():Promise<any[]> {
    const mdb=await mongoDb(); const baseName=tableName(this.base); const baseDocs=await mdb.collection(baseName).find({}, {session:this.session}).toArray(); let rowsets=baseDocs.map(doc=>({[baseName]: doc}));
    for(const j of this.joins){const tn=tableName(j.table);const docs=await mdb.collection(tn).find({}, {session:this.session}).toArray();const next:any[]=[];for(const row of rowsets){let hit=false;for(const doc of docs){const merged={...row,[tn]:doc};if(matches(j.predicate,merged)){next.push(merged);hit=true;}}if(j.left&&!hit)next.push({...row,[tn]:null});}rowsets=next;}
    rowsets=rowsets.filter(r=>matches(this.predicate,r));
    if(this.groups.length){const keys=new Map<string,any[]>();for(const r of rowsets){const k=JSON.stringify(this.groups.map(g=>rawValue(g,r)));if(!keys.has(k))keys.set(k,[]);keys.get(k)!.push(r);}rowsets=[...keys.values()].map(group=>({...group[0],__group:group}));}
    if(this.orders.length) rowsets.sort((a,b)=>{for(const o of this.orders){const sqlSort=o?.kind==="sql" && /DESC/i.test(sqlText(o));const col=o?.kind==="desc"?o.args[0]:o?.kind==="asc"?o.args[0]:sqlSort?o.args[1]:o;const av=rawValue(col,a),bv=rawValue(col,b);if(av===bv)continue;const sign=(o?.kind==="desc"||sqlSort)?-1:1;return (av>bv?1:-1)*sign;}return 0;});
    if(this.max!==undefined)rowsets=rowsets.slice(0,this.max);
    if(!this.groups.length && this.selection && Object.values(this.selection).some((v:any)=>v?.kind==="sql" && /count\s*\(/i.test(sqlText(v)))) { const one:any={}; for(const [k,v] of Object.entries(this.selection)){one[k]=(v as any)?.kind==="sql"&&/count\s*\(/i.test(sqlText(v as Expr))?rowsets.length:rawValue(v,rowsets[0]??{});} return [one]; }
    return rowsets.map(r=>{const out=projection(this.selection,r);if(r.__group&&this.selection){for(const [key,value] of Object.entries(this.selection)){if((value as any)?.kind==="sql"&&/count\s*\(/i.test(sqlText(value as Expr)))out[key]=r.__group.length;}}return out;});
  }
  then(resolve:any,reject:any){return this.run().then(resolve,reject);}
}
class InsertQuery {
  private docs:any[]=[]; private doConflict:any; private returningSelection:any;
  constructor(private table:any,private session?:ClientSession){}
  values(v:any){this.docs=Array.isArray(v)?v:[v];return this;}
  onConflictDoUpdate(opts:any){this.doConflict=opts;return this;}
  returning(selection?:any){this.returningSelection=selection;return this.execute();}
  async execute(){const mdb=await mongoDb();const tn=tableName(this.table);const coll=mdb.collection(tn);const inserted:any[]=[];for(const original of this.docs){const doc={...original};const cols=columns(this.table);const idCol=cols.id;
      const defaults:Record<string,Record<string,any>>={
        users:{role:"user",walletBalance:0,coinBalance:0,country:"OTHER",suspended:false,createdAt:new Date()},
        templates:{isFree:false,isFeatured:false,showDeployCount:true,price:0,currency:"NGN",createdAt:new Date()},
        deployments:{status:"queued",envVars:{},logs:[],createdAt:new Date(),updatedAt:new Date()},
        payments:{currency:"NGN",status:"pending",method:"card",createdAt:new Date()},
        wallet_transactions:{currency:"NGN",status:"pending",balanceAfter:0,createdAt:new Date()},
        coin_transactions:{createdAt:new Date()},
      };
      for(const [k,v] of Object.entries(defaults[tn]??{})) if(doc[k]===undefined) doc[k]=v; if(idCol && doc.id==null){const counter=await mdb.collection("_counters").findOneAndUpdate({_id:tn},{$inc:{seq:1}},{upsert:true,returnDocument:"after",session:this.session});doc.id=counter?.seq??1;}for(const [k,c] of Object.entries(cols)){if(doc[k]===undefined&&((c as any).default!==undefined))doc[k]=(c as any).default;}if(this.doConflict){const target=this.doConflict.target;const key=typeof target==="string"?target:(target?Object.entries(cols).find(([,c])=>c===target)?.[0]:undefined) ?? target?.name;const match=key?await coll.findOne({[key]:doc[key]},{session:this.session}):null;if(match){await coll.updateOne({_id:match._id},{$set:this.doConflict.set},{session:this.session});inserted.push({...match,...this.doConflict.set});continue;}}const result=await coll.insertOne(doc,{session:this.session});inserted.push({...doc,_id:result.insertedId});}return this.returningSelection?inserted.map(d=>projection(this.returningSelection,{[tn]:d})):[];}
  then(resolve:any,reject:any){return this.execute().then(resolve,reject);}
}
class UpdateQuery {
  private valuesToSet:any={};private predicate:any;private returningSelection:any;
  constructor(private table:any,private session?:ClientSession){}
  set(v:any){this.valuesToSet=v;return this;} where(p:any){this.predicate=p;return this;} returning(s?:any){this.returningSelection=s;return this.execute();}
  async execute(){const mdb=await mongoDb();const tn=tableName(this.table);const coll=mdb.collection(tn);const docs=await coll.find({}, {session:this.session}).toArray();const out:any[]=[];for(const doc of docs){const rows={[tn]:doc};if(!matches(this.predicate,rows))continue;const set:any={};for(const [k,v] of Object.entries(this.valuesToSet))set[k]=updateValue(v,doc[k],rows);await coll.updateOne({_id:doc._id},{$set:set},{session:this.session});out.push({...doc,...set});}return this.returningSelection?out.map(d=>projection(this.returningSelection,{[tn]:d})):[];}
  then(resolve:any,reject:any){return this.execute().then(resolve,reject);}
}
class DeleteQuery {
 private predicate:any;constructor(private table:any,private session?:ClientSession){} where(p:any){this.predicate=p;return this;} async execute(){const mdb=await mongoDb();const tn=tableName(this.table);const coll=mdb.collection(tn);const docs=await coll.find({}, {session:this.session}).toArray();const deleted:any[]=[];for(const d of docs)if(matches(this.predicate,{[tn]:d})){deleted.push(d);await coll.deleteOne({_id:d._id},{session:this.session});}
    // Preserve the cascade relationships declared in the original relational schema.
    if(tn==="users"){for(const d of deleted){for(const child of ["deployments","payments","wallet_transactions","coin_transactions"]){const fk=child==="wallet_transactions"||child==="coin_transactions"||child==="payments"||child==="deployments"?"userId":"userId";await mdb.collection(child).deleteMany({[fk]:d.id},{session:this.session});}}}
    if(tn==="templates"){for(const d of deleted){await mdb.collection("deployments").deleteMany({templateId:d.id},{session:this.session});await mdb.collection("payments").deleteMany({templateId:d.id},{session:this.session});}}
    return [];}then(resolve:any,reject:any){return this.execute().then(resolve,reject);}
}
class MongoStore {
  constructor(private session?:ClientSession){}
  select(selection?:any){return new SelectQuery(selection,this.session);}
  insert(table:any){return new InsertQuery(table,this.session);}
  update(table:any){return new UpdateQuery(table,this.session);}
  delete(table:any){return new DeleteQuery(table,this.session);}
  async execute(_query:any){return [];}
  async transaction<T>(callback:(tx:MongoStore)=>Promise<T>):Promise<T>{if(this.session)return callback(this);await client.connect();const session=client.startSession();try{let result!:T;await session.withTransaction(async()=>{result=await callback(new MongoStore(session));});return result;}finally{await session.endSession();}}
}
export const db:any=new MongoStore();
