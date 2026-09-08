import {beforeAll,describe,expect,it} from "vitest";
import {normalizePersonName} from "@/lib/business/name-matching";
import type {PersonIdentityDirectory} from "@/lib/business/person-identity";
import type {ParsedAhivimRow} from "@/lib/excel/parse-workbook";
import {sourceBaseCheckCandidates} from "@/lib/sheets/base-recovery";
import {sourceNetCheckGroup} from "@/lib/sheets/source-net-check-group";
import {parseSheetCsv} from "@/lib/sheets/parse-csv";
import {numericSheetFixture} from "./support/sheet-numeric-fixture";

let original:ParsedAhivimRow;
beforeAll(async()=>{original=parseSheetCsv((await numericSheetFixture()).csv).ahivimRows[0]!;});
const name="Synthetic Numeric Employee",old="Old Employee Spelling";
const person=(id:string,displayName:string,status="active")=>({id,displayName,normalizedName:normalizePersonName(displayName),status});
const alias=(targetId:string,status:"approved"|"pending"="approved")=>({targetId,status,normalizedAlias:normalizePersonName(old)});
function row(sourceRowNumber:number,fields:Record<string,string|null>={},malformed=false):ParsedAhivimRow {
  return {...original,sourceRowNumber,raw:{...original.raw,...Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,value??""]))},
    parsed:malformed?null:{...original.parsed!,...fields}};
}

describe("Source base check candidate index preserves the complete source guard",()=>{
  for(const scenario of ["known_other","approved_alias","unknown","pending","dangling","collision","disjoint_collision",
    "audited_merge","folded_missing_alias","malformed_undated","malformed_other_date","transitive_partial_dates"] as const){
    it(`matches unfiltered check membership and ambiguity for ${scenario}`,()=>{
      const directory:PersonIdentityDirectory={people:[person("target",name),person("other","Other Known Employee")],aliases:[],merges:[]};
      let special=[row(5,{employee:old})];
      if(scenario==="known_other")special=[row(5,{employee:"Other Known Employee"})];
      if(scenario==="approved_alias")directory.aliases=[alias("target")];
      if(scenario==="pending")directory.aliases=[alias("target","pending")];
      if(scenario==="dangling")directory.aliases=[alias("missing")];
      if(scenario==="collision"){directory.people=[...directory.people,person("archived",old)];directory.aliases=[alias("target")];}
      if(scenario==="disjoint_collision"){directory.people=[...directory.people,person("third",old)];directory.aliases=[alias("other")];}
      if(scenario==="audited_merge"||scenario==="folded_missing_alias"){
        directory.people=[...directory.people,person("archived",old,"archived")];
        directory.merges=[{mergedId:"archived",survivorId:"target",mergedName:old}];
        if(scenario==="audited_merge")directory.aliases=[alias("target")];
      }
      if(scenario==="malformed_undated")special=[row(5,{employee:old,checkNumber:null,checkDate:null,periodBegin:null,periodEnd:null},true)];
      if(scenario==="malformed_other_date")special=[row(5,{employee:old,checkNumber:null,checkDate:"09/21/2026",periodBegin:"09/01/2026",periodEnd:"09/15/2026"},true)];
      if(scenario==="transitive_partial_dates")special=[row(7,{employee:old,checkNumber:"LINKED",checkDate:null}),row(6,{checkNumber:"LINKED",checkDate:null}),row(5,{checkNumber:null})];
      const unrelated=Array.from({length:200},(_,index)=>row(100+index,{employee:"Other Known Employee",checkNumber:`OTHER-${index}`}));
      const full=[...special,...unrelated,row(4)],indexed=sourceBaseCheckCandidates(full,directory)("target");
      const sourceDirectory={employees:directory.people,aliases:directory.aliases,merges:directory.merges};
      const reference=sourceNetCheckGroup(full,original.parsed!,"target",sourceDirectory);
      expect(sourceNetCheckGroup(indexed,original.parsed!,"target",sourceDirectory)).toEqual(reference);
      expect(indexed.length).toBeLessThan(10);
      expect(reference.unresolved).toBe(!["known_other","approved_alias","disjoint_collision","audited_merge","malformed_other_date"].includes(scenario));
    });
  }
});
