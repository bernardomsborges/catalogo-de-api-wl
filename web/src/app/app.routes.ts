import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { Routes, UrlMatchResult, UrlSegment } from '@angular/router';
import { adminGuard, adminRoleGuard, loginGuard } from './core/auth';

function apiDetailMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments[0]?.path !== 'apis' || segments.length < 2 || segments.length > 3) return null;
  const posParams: Record<string, UrlSegment> = { slug: segments[1] };
  if (segments[2]) posParams['tab'] = segments[2];
  return { consumed: segments, posParams };
}

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home/home').then((m) => m.Home) },
  { path: 'apis', title: 'APIs', loadComponent: () => import('./pages/catalog/catalog').then((m) => m.Catalog) },
  // One route for /apis/:slug and /apis/:slug/:tab, so switching tabs reuses the page
  // instead of destroying it and fetching the API again.
  { matcher: apiDetailMatcher, loadComponent: () => import('./pages/api-detail/api-detail').then((m) => m.ApiDetail) },
  { path: 'status', title: 'Status das APIs', loadComponent: () => import('./pages/status/status').then((m) => m.StatusPage) },
  { path: 'receapitos', title: 'ReceAPItos', loadComponent: () => import('./pages/recipes/recipes-list').then((m) => m.RecipesList) },
  { path: 'receapitos/:slug', title: 'ReceAPIto', loadComponent: () => import('./pages/recipes/recipe-detail').then((m) => m.RecipeDetail) },
  // Old addresses (links already shared) keep working.
  { path: 'receitas', redirectTo: 'receapitos', pathMatch: 'full' },
  { path: 'receitas/:slug', redirectTo: 'receapitos/:slug' },
  { path: 'acompanhar/confirmar', title: 'Acompanhar API', data: { action: 'confirmar' }, loadComponent: () => import('./pages/follow/follow').then((m) => m.Follow) },
  { path: 'acompanhar/cancelar', title: 'Deixar de acompanhar', data: { action: 'cancelar' }, loadComponent: () => import('./pages/follow/follow').then((m) => m.Follow) },
  { path: 'entrar/sso', title: 'Entrando', loadComponent: () => import('./pages/account/sso-return').then((m) => m.SsoReturn) },
  { path: 'entrar', title: 'Entrar', loadComponent: () => import('./pages/account/login').then((m) => m.Login) },
  { path: 'cadastro', title: 'Criar conta', data: { cadastro: true }, loadComponent: () => import('./pages/account/login').then((m) => m.Login) },
  { path: 'esqueci-senha', title: 'Esqueci minha senha', loadComponent: () => import('./pages/account/password-reset').then((m) => m.PasswordReset) },
  { path: 'redefinir-senha', title: 'Criar senha nova', loadComponent: () => import('./pages/account/password-reset').then((m) => m.PasswordReset) },
  { path: 'conta', title: 'Minha conta', canActivate: [loginGuard], loadComponent: () => import('./pages/account/account').then((m) => m.AccountPage) },
  { path: 'admin/login', redirectTo: () => inject(Router).parseUrl('/entrar?voltar=%2Fadmin') },
  {
    path: 'admin',
    canActivate: [adminGuard],
    children: [
      { path: '', title: 'Painel admin', loadComponent: () => import('./pages/admin/admin-list').then((m) => m.AdminList) },
      { path: 'pessoas', title: 'Pessoas e acesso · Admin', canActivate: [adminRoleGuard], loadComponent: () => import('./pages/admin/people').then((m) => m.People) },
      { path: 'nova', title: 'Nova API · Admin', loadComponent: () => import('./pages/admin/api-form').then((m) => m.ApiForm) },
      { path: 'sistemas', title: 'Sistemas consumidores · Admin', loadComponent: () => import('./pages/admin/systems').then((m) => m.Systems) },
      { path: 'metricas', title: 'Métricas de uso · Admin', loadComponent: () => import('./pages/admin/metrics').then((m) => m.Metrics) },
      { path: 'perguntas', title: 'Perguntas sem resposta · Admin', loadComponent: () => import('./pages/admin/ai-gaps').then((m) => m.AiGaps) },
      { path: 'importar', title: 'Importar APIs · Admin', loadComponent: () => import('./pages/admin/import-apis').then((m) => m.ImportApis) },
      { path: 'receapitos', title: 'ReceAPItos · Admin', loadComponent: () => import('./pages/admin/recipe-admin-list').then((m) => m.RecipeAdminList) },
      { path: 'receapitos/novo', title: 'Novo ReceAPIto · Admin', loadComponent: () => import('./pages/admin/recipe-form').then((m) => m.RecipeForm) },
      { path: 'receapitos/editar/:id', title: 'Editar ReceAPIto · Admin', loadComponent: () => import('./pages/admin/recipe-form').then((m) => m.RecipeForm) },
      { path: 'receitas', redirectTo: 'receapitos', pathMatch: 'full' },
      { path: 'receitas/nova', redirectTo: 'receapitos/novo' },
      { path: 'receitas/editar/:id', redirectTo: 'receapitos/editar/:id' },
      { path: 'editar/:id', title: 'Editar API · Admin', loadComponent: () => import('./pages/admin/api-form').then((m) => m.ApiForm) },
    ],
  },
  { path: '**', redirectTo: '' },
];
