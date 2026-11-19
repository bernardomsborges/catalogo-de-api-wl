import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Account, Role } from './auth';

export interface Group {
  id: string;
  name: string;
  description: string;
  requestable: boolean;
  memberCount: number;
  members?: Account[];
}

export interface AccessRequest {
  id: string;
  userId: string;
  apiId: string | null;
  apiName?: string;
  groupId: string | null;
  message: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  user: { id: string; name: string; email: string } | null;
  group: { id: string; name: string } | null;
  /** Requests about an API: the groups that give access to it. */
  apiGroups?: string[];
}

export interface AdminAccount extends Account {
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Access requests (for everybody with an account) and people/groups management (admins). */
@Injectable({ providedIn: 'root' })
export class AccessService {
  private http = inject(HttpClient);

  // ----- own account -----
  requestableGroups() {
    return firstValueFrom(this.http.get<Group[]>('/api/account/groups'));
  }
  myRequests() {
    return firstValueFrom(this.http.get<AccessRequest[]>('/api/account/requests'));
  }
  request(input: { api?: string; groupId?: string; message?: string }) {
    return firstValueFrom(this.http.post<AccessRequest>('/api/account/requests', input));
  }

  // ----- API form (admins and editors) -----
  groups() {
    return firstValueFrom(this.http.get<Group[]>('/api/groups'));
  }

  // ----- admins -----
  users() {
    return firstValueFrom(this.http.get<AdminAccount[]>('/api/admin/users'));
  }
  createUser(input: { email: string; name: string; password: string; role: Role; groups: string[] }) {
    return firstValueFrom(this.http.post<AdminAccount>('/api/admin/users', input));
  }
  updateUser(id: string, input: Partial<{ name: string; email: string; role: Role; groups: string[]; disabled: boolean; password: string }>) {
    return firstValueFrom(this.http.put<AdminAccount>(`/api/admin/users/${id}`, input));
  }
  endSessions(id: string) {
    return firstValueFrom(this.http.post(`/api/admin/users/${id}/logout-all`, {}));
  }
  removeUser(id: string) {
    return firstValueFrom(this.http.delete(`/api/admin/users/${id}`));
  }
  adminGroups() {
    return firstValueFrom(this.http.get<Group[]>('/api/admin/groups'));
  }
  saveGroup(id: string | null, input: { name: string; description: string; requestable: boolean }) {
    return firstValueFrom(id ? this.http.put<Group>(`/api/admin/groups/${id}`, input) : this.http.post<Group>('/api/admin/groups', input));
  }
  removeGroup(id: string) {
    return firstValueFrom(this.http.delete(`/api/admin/groups/${id}`));
  }
  requests(status?: 'pending') {
    return firstValueFrom(this.http.get<AccessRequest[]>('/api/admin/requests', { params: status ? { status } : {} }));
  }
  approve(id: string, groupId: string | null, note = '') {
    return firstValueFrom(this.http.post<AccessRequest>(`/api/admin/requests/${id}/approve`, { groupId, note }));
  }
  reject(id: string, note = '') {
    return firstValueFrom(this.http.post<AccessRequest>(`/api/admin/requests/${id}/reject`, { note }));
  }
}
